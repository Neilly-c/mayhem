"""PPO self-play training CLI entrypoint (Python/PyTorch side of the Node<->Python bridge).
Mirrors src/train/trainPPO.ts's loop shape: collect -> PPO update -> log -> periodic
checkpoint+eval+replay -> curriculum stage check. All actual sim ticks run through the Node
`envWorker.ts` subprocess pool (`WorkerPool`); this process only holds the network/optimizer and
the rollout/GAE bookkeeping.

Eval and replay recording are tied to the *same* cadence as checkpointing (not independent
cadences like the TS pipeline's `evalEveryIterations`/`replayEveryIterations`): both require a
TF.js export of the current weights (`export_tfjs`), and that export is a cross-process subprocess
call, so it's only worth paying for right when a checkpoint is saved anyway. Tune
`--checkpoint-every` down if you want eval/replay more often.

Usage: python train_ppo.py [--num-envs N] [--num-workers N] [--rollout-length N]
    [--iterations N] [--seed N] [--gamma F] [--lambda F] [--clip-ratio F] [--epochs N]
    [--minibatch-size N] [--value-loss-coef F] [--entropy-coef F] [--learning-rate F]
    [--eval-episodes N] [--checkpoint-every N] [--checkpoint-dir DIR] [--keep-top-n-checkpoints N]
    [--replay-dir DIR] [--replay-opponent expander|guardian|raider|selfPlay] [--resume-from DIR]
    [--log-path PATH] [--device cpu|cuda]
"""

from __future__ import annotations

import argparse
import random
import re
from dataclasses import dataclass, field
from pathlib import Path

import torch

from mayhem_rl.bridge.worker_pool import WorkerPool
from mayhem_rl.checkpoint import (
    ensure_tfjs_template,
    export_tfjs,
    load_checkpoint,
    make_checkpoint_meta,
    mean_win_rate,
    save_checkpoint,
    set_checkpoint_score,
)
from mayhem_rl.checkpoint_pruning import list_checkpoints, prune_checkpoints
from mayhem_rl.eval_and_replay import evaluate_checkpoint, prune_replays, record_replay_for_checkpoint
from mayhem_rl.logging_utils import Logger
from mayhem_rl.network import ActorCriticNetwork
from mayhem_rl.ppo import PPOConfig, run_ppo_update
from mayhem_rl.rollout_buffer import collect_rollout, create_rollout_state

_CHECKPOINT_DIR_PATTERN = re.compile(r"^py-iter-\d+$")
# Replay pruning must see TS(iter-N) and Python(py-iter-N) checkpoints alike -- public/replays is
# shared between both pipelines, so filtering the keep-set by only this pipeline's own pattern
# would wrongly delete replays for checkpoints the *other* pipeline still has.
_ANY_CHECKPOINT_DIR_PATTERN = re.compile(r"^(py-)?iter-\d+$")


@dataclass
class TrainConfig:
    num_envs: int = 8
    num_workers: int | None = None
    rollout_length: int = 128
    iterations: int = 1000
    seed: int = 1
    gamma: float = 0.99
    lam: float = 0.95
    ppo: PPOConfig = field(default_factory=PPOConfig)
    hidden_sizes: tuple[int, ...] = (256, 256)
    eval_episodes_per_matchup: int = 5
    checkpoint_every_iterations: int = 20
    checkpoint_dir: str = "checkpoints"
    keep_top_n_checkpoints: int = 3
    replay_dir: str = "public/replays"
    replay_opponent: str = "expander"
    resume_from: str | None = None
    log_path: str | None = None
    device: str = "cpu"


def parse_args() -> TrainConfig:
    p = argparse.ArgumentParser()
    p.add_argument("--num-envs", type=int, default=8)
    p.add_argument("--num-workers", type=int, default=None)
    p.add_argument("--rollout-length", type=int, default=128)
    p.add_argument("--iterations", type=int, default=1000)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--gamma", type=float, default=0.99)
    p.add_argument("--lambda", dest="lam", type=float, default=0.95)
    p.add_argument("--clip-ratio", type=float, default=0.2)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--minibatch-size", type=int, default=256)
    p.add_argument("--value-loss-coef", type=float, default=0.5)
    p.add_argument("--entropy-coef", type=float, default=0.01)
    p.add_argument("--learning-rate", type=float, default=3e-4)
    p.add_argument("--eval-episodes", type=int, default=5)
    p.add_argument("--checkpoint-every", type=int, default=20)
    p.add_argument("--checkpoint-dir", type=str, default="checkpoints")
    p.add_argument("--keep-top-n-checkpoints", type=int, default=3)
    p.add_argument("--replay-dir", type=str, default="public/replays")
    p.add_argument(
        "--replay-opponent", type=str, default="expander", choices=["expander", "guardian", "raider", "selfPlay"]
    )
    p.add_argument("--resume-from", type=str, default=None)
    p.add_argument("--log-path", type=str, default=None)
    p.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu")
    args = p.parse_args()

    return TrainConfig(
        num_envs=args.num_envs,
        num_workers=args.num_workers,
        rollout_length=args.rollout_length,
        iterations=args.iterations,
        seed=args.seed,
        gamma=args.gamma,
        lam=args.lam,
        ppo=PPOConfig(
            clip_ratio=args.clip_ratio,
            epochs=args.epochs,
            minibatch_size=args.minibatch_size,
            value_loss_coef=args.value_loss_coef,
            entropy_coef=args.entropy_coef,
            learning_rate=args.learning_rate,
        ),
        eval_episodes_per_matchup=args.eval_episodes,
        checkpoint_every_iterations=args.checkpoint_every,
        checkpoint_dir=args.checkpoint_dir,
        keep_top_n_checkpoints=args.keep_top_n_checkpoints,
        replay_dir=args.replay_dir,
        replay_opponent=args.replay_opponent,
        resume_from=args.resume_from,
        log_path=args.log_path,
        device=args.device,
    )


def main() -> None:
    config = parse_args()
    logger = Logger(config.log_path)
    device = torch.device(config.device)

    # teamCount:6, unitsPerTeam:3 per the pipeline's fixed training scale (see
    # src/train/curriculum.ts, resolved over the bridge below) -- mapRadius is the only curriculum
    # dimension that changes across iterations; the others determine the network's input/output
    # shape and must stay fixed for a run.
    pool = WorkerPool(
        num_envs=config.num_envs,
        num_workers=config.num_workers,
        base_seed=config.seed,
        sim_config_overrides=pool_sim_config_for_iteration(config, 0),
        timeout=60.0,
    )

    iteration_start = 0
    try:
        if config.resume_from:
            network, meta = load_checkpoint(config.resume_from)
            iteration_start = meta["iteration"]
            network_config = meta["networkConfig"]
            logger.log({"event": "resumed", "iteration": iteration_start, "dir": config.resume_from})
        else:
            network_config = {
                "obsDim": pool.obs_dim,
                "maxVisibleEnemies": pool.max_visible_enemies,
                "hiddenSizes": list(config.hidden_sizes),
            }
            network = ActorCriticNetwork(
                obs_dim=pool.obs_dim, max_visible_enemies=pool.max_visible_enemies, hidden_sizes=config.hidden_sizes
            )
            logger.log({"event": "initialized", "networkConfig": network_config})
        network.to(device)

        # Generated once, reused for every checkpoint's export_tfjs call this run (networkConfig
        # is fixed for the whole run -- see the module docstring).
        tfjs_template_dir = Path(config.checkpoint_dir) / "_tfjs_template"
        ensure_tfjs_template(network_config, tfjs_template_dir)

        # Optimizer state (momentum/velocity) is not checkpointed in v1 -- a resumed run starts
        # with a fresh optimizer even though the model weights themselves carry over (same
        # documented simplification as the TS pipeline's trainPPO.ts).
        optimizer = torch.optim.Adam(network.parameters(), lr=config.ppo.learning_rate)

        rollout_state = create_rollout_state(pool, base_seed=config.seed)
        shuffle_rng = random.Random(config.seed)
        action_rng = random.Random(config.seed + 1)

        current_sim_config = pool_sim_config_for_iteration(config, iteration_start)

        for iteration in range(iteration_start, config.iterations):
            desired_sim_config = pool.resolve_sim_config(iteration)
            if desired_sim_config != current_sim_config:
                # Curriculum stage changed (mapRadius grew) -- envs are permanently bound to the
                # simConfig they were created with, so the whole pool must be rebuilt (same
                # constraint trainPPO.ts documents for its own env pool).
                current_sim_config = desired_sim_config
                pool.close()
                pool = WorkerPool(
                    num_envs=config.num_envs,
                    num_workers=config.num_workers,
                    base_seed=config.seed + iteration,
                    sim_config_overrides=current_sim_config,
                    timeout=60.0,
                )
                rollout_state = create_rollout_state(pool, base_seed=config.seed + iteration)
                logger.log({"event": "curriculum_stage_change", "iteration": iteration, "simConfig": current_sim_config})

            batch = collect_rollout(
                rollout_state,
                network,
                device,
                rollout_length=config.rollout_length,
                gamma=config.gamma,
                lam=config.lam,
                action_rng=action_rng,
            )

            stats = run_ppo_update(network, optimizer, batch.steps, config.ppo, device, shuffle_rng)

            mean_episode_return = sum(batch.episode_returns) / len(batch.episode_returns) if batch.episode_returns else None
            logger.log(
                {
                    "event": "iteration",
                    "iteration": iteration,
                    "steps": len(batch.steps),
                    "episodes": len(batch.episode_returns),
                    "meanEpisodeReturn": mean_episode_return,
                    "policyLoss": stats.policy_loss,
                    "valueLoss": stats.value_loss,
                    "entropy": stats.entropy,
                    "approxKl": stats.approx_kl,
                    "clipFraction": stats.clip_fraction,
                }
            )

            if (iteration + 1) % config.checkpoint_every_iterations == 0:
                milestone = iteration + 1
                meta = make_checkpoint_meta(milestone, network_config, current_sim_config)
                out_dir = Path(config.checkpoint_dir) / f"py-iter-{milestone}"
                save_checkpoint(network, out_dir, meta)  # PyTorch-native, for --resume-from
                export_tfjs(network, tfjs_template_dir, out_dir)  # TF.js format, for eval/replay
                logger.log({"event": "checkpoint", "iteration": milestone, "dir": str(out_dir)})

                eval_report = evaluate_checkpoint(
                    out_dir, milestone, seed_base=config.seed + iteration, episodes=config.eval_episodes_per_matchup
                )
                logger.log({"event": "eval", **eval_report})

                # Eval only finishes after the checkpoint is already on disk (it needs the TF.js
                # export above), so the score is patched into meta.json as a follow-up write --
                # `select_checkpoints_to_keep` below reads it back from there.
                score = mean_win_rate(eval_report)
                set_checkpoint_score(out_dir, score)

                replay_entry = record_replay_for_checkpoint(
                    out_dir,
                    milestone,
                    seed=config.seed + iteration,
                    opponent=config.replay_opponent,
                    replay_dir=config.replay_dir,
                )
                logger.log({"event": "replay", **replay_entry})

                deleted = prune_checkpoints(config.checkpoint_dir, _CHECKPOINT_DIR_PATTERN, config.keep_top_n_checkpoints)
                if deleted:
                    logger.log(
                        {"event": "checkpoint_pruned", "iteration": milestone, "deleted": [str(d) for d in deleted]}
                    )

                # ユーザー要望: 間引きで消えたチェックポイント世代のリプレイもUIから消す(TS側の
                # trainPPO.tsと同じ考え方 -- 生き残ったチェックポイントの反復回数だけを残す)。
                # _ANY_CHECKPOINT_DIR_PATTERNでTS/Python両方の現存チェックポイントを見る --
                # 自分側のパターンだけだと、TS側が今も持っているチェックポイントのリプレイまで
                # 誤って削除してしまう。
                kept_iterations = {
                    c.iteration for c in list_checkpoints(config.checkpoint_dir, _ANY_CHECKPOINT_DIR_PATTERN)
                }
                deleted_replays = prune_replays(config.replay_dir, kept_iterations)
                if deleted_replays:
                    logger.log({"event": "replay_pruned", "iteration": milestone, "deleted": deleted_replays})

        logger.log({"event": "done", "iterations": config.iterations})
    finally:
        pool.close()


def pool_sim_config_for_iteration(config: TrainConfig, iteration: int) -> dict:
    """Only used to seed the very first WorkerPool before it exists to ask the worker itself for
    the curriculum's answer; a throwaway single-env pool would be wasteful, so iteration 0's
    config is inlined here matching curriculum.ts's known stage-0 shape (mapRadius:8,
    teamCount:6, unitsPerTeam:3) and immediately reconciled against the real `resolveSimConfig`
    answer on the very first loop iteration."""
    return {"mapRadius": 8, "teamCount": 6, "unitsPerTeam": 3}


if __name__ == "__main__":
    main()
