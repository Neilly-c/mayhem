"""Vectorized rollout collection driving a `WorkerPool` (the bridge's equivalent of
src/train/rolloutBuffer.ts, which drives in-process `Env` instances directly). Mirrors that
file's batching-by-flattening-alive-(env,unit)-pairs approach, its auto-reset handling, and its
segment-per-life GAE bookkeeping — adapted so that the actual env-stepping happens over the wire
via `WorkerPool`, and every forward pass (including bootstrap-value-only passes) happens here in
Python, never inside a Node worker (the bridge's non-negotiable constraint).
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any

import torch

from .action_sampling import sample_masked_categorical
from .bridge.worker_pool import WorkerPool
from .gae import GaeSegment, compute_gae
from .network import ActorCriticNetwork
from .ppo import RolloutStep


def _initial_seed(base_seed: int, global_index: int) -> int:
    """Only used for the *explicit* initial reset — auto-resets that happen organically during
    `step()` are seeded by the worker itself (via its own `baseSeed` + `deriveRng`, see
    envWorker.ts), so this doesn't need to match that convention; it just needs to be
    deterministic and distinct per env for reproducibility within a Python run."""
    rng = random.Random(f"{base_seed}:{global_index}:reset0")
    return rng.randrange(2**31)


@dataclass
class RolloutState:
    pool: WorkerPool
    base_seed: int
    episode_ids: list[int]
    # per global env index: {unitId: {"observation": [...], "visibleEnemyIds": [...], "actionMask": {...}}}
    agents_by_env: list[dict[int, dict[str, Any]]]


def create_rollout_state(pool: WorkerPool, base_seed: int) -> RolloutState:
    seeds = {i: _initial_seed(base_seed, i) for i in range(pool.num_envs)}
    reset_result = pool.reset(seeds)

    episode_ids = [0] * pool.num_envs
    agents_by_env: list[dict[int, dict[str, Any]]] = [dict() for _ in range(pool.num_envs)]
    for global_index, env_result in reset_result.items():
        episode_ids[global_index] = env_result["episodeId"]
        agents_by_env[global_index] = {a["unitId"]: a for a in env_result["agents"]}

    return RolloutState(pool=pool, base_seed=base_seed, episode_ids=episode_ids, agents_by_env=agents_by_env)


@dataclass
class _RawRecord:
    env_index: int
    episode_id: int
    unit_id: int
    obs: list[float]
    move_mask: list[bool]
    attack_mask: list[bool]
    ability_mask: list[bool]
    move_action: int
    attack_action: int
    ability_action: int
    old_log_prob: float
    value: float
    reward: float
    terminated: bool


@dataclass
class RolloutBatch:
    steps: list[RolloutStep]
    episode_returns: list[float]


def _compute_values(network: ActorCriticNetwork, device: torch.device, obs_list: list[list[float]]) -> list[float]:
    if not obs_list:
        return []
    with torch.no_grad():
        obs_t = torch.tensor(obs_list, dtype=torch.float32, device=device)
        _, _, _, value = network(obs_t)
    return value.squeeze(-1).cpu().tolist()


def collect_rollout(
    state: RolloutState,
    network: ActorCriticNetwork,
    device: torch.device,
    rollout_length: int,
    gamma: float,
    lam: float,
    action_rng: random.Random,
) -> RolloutBatch:
    pool = state.pool
    records: list[_RawRecord] = []
    bootstrap_values: dict[tuple[int, int, int], float] = {}
    episode_return_accum: list[dict[int, float]] = [dict() for _ in range(pool.num_envs)]
    episode_returns: list[float] = []

    for _step in range(rollout_length):
        active: list[tuple[int, int]] = []  # (env_index, unit_id)
        obs_rows: list[list[float]] = []
        move_mask_rows: list[list[bool]] = []
        attack_mask_rows: list[list[bool]] = []
        ability_mask_rows: list[list[bool]] = []

        for env_index in range(pool.num_envs):
            for unit_id, agent in state.agents_by_env[env_index].items():
                active.append((env_index, unit_id))
                obs_rows.append(agent["observation"])
                move_mask_rows.append(agent["actionMask"]["move"])
                attack_mask_rows.append(agent["actionMask"]["attack"])
                ability_mask_rows.append(agent["actionMask"]["ability"])

        if not active:
            break  # defensive; shouldn't happen given per-step auto-reset, mirrors rolloutBuffer.ts

        obs_t = torch.tensor(obs_rows, dtype=torch.float32, device=device)
        move_mask_t = torch.tensor(
            [[1.0 if b else 0.0 for b in row] for row in move_mask_rows], dtype=torch.float32, device=device
        )
        attack_mask_t = torch.tensor(
            [[1.0 if b else 0.0 for b in row] for row in attack_mask_rows], dtype=torch.float32, device=device
        )
        ability_mask_t = torch.tensor(
            [[1.0 if b else 0.0 for b in row] for row in ability_mask_rows], dtype=torch.float32, device=device
        )

        seed = action_rng.randrange(2**31)
        gen_move = torch.Generator().manual_seed(seed)
        gen_attack = torch.Generator().manual_seed(seed + 1)
        gen_ability = torch.Generator().manual_seed(seed + 2)

        with torch.no_grad():
            move_logits, attack_logits, ability_logits, value_t = network(obs_t)
            # Action sampling always happens on CPU regardless of `device`: it's a handful of
            # floats per row (not the network forward pass itself), and `torch.multinomial`'s
            # `generator` argument must live on the same device as the tensor it samples from —
            # sampling on CPU sidesteps needing a CUDA generator at all.
            move_sample = sample_masked_categorical(move_logits.cpu(), move_mask_t.cpu(), generator=gen_move)
            attack_sample = sample_masked_categorical(attack_logits.cpu(), attack_mask_t.cpu(), generator=gen_attack)
            ability_sample = sample_masked_categorical(
                ability_logits.cpu(), ability_mask_t.cpu(), generator=gen_ability
            )
            joint_log_prob = move_sample.log_probs + attack_sample.log_probs + ability_sample.log_probs

        move_actions = move_sample.actions.tolist()
        attack_actions = attack_sample.actions.tolist()
        ability_actions = ability_sample.actions.tolist()
        old_log_probs = joint_log_prob.tolist()
        values = value_t.squeeze(-1).cpu().tolist()

        actions_by_env: dict[int, list[dict[str, Any]]] = {}
        for i, (env_index, unit_id) in enumerate(active):
            actions_by_env.setdefault(env_index, []).append(
                {
                    "unitId": unit_id,
                    "move": move_actions[i],
                    "attack": attack_actions[i],
                    "ability": ability_actions[i],
                }
            )

        step_result = pool.step(actions_by_env)

        for i, (env_index, unit_id) in enumerate(active):
            env_result = step_result[env_index]
            unit_result = next(u for u in env_result["units"] if u["unitId"] == unit_id)
            records.append(
                _RawRecord(
                    env_index=env_index,
                    episode_id=env_result["episodeId"],
                    unit_id=unit_id,
                    obs=obs_rows[i],
                    move_mask=move_mask_rows[i],
                    attack_mask=attack_mask_rows[i],
                    ability_mask=ability_mask_rows[i],
                    move_action=move_actions[i],
                    attack_action=attack_actions[i],
                    ability_action=ability_actions[i],
                    old_log_prob=old_log_probs[i],
                    value=values[i],
                    reward=unit_result["reward"],
                    terminated=unit_result["terminated"],
                )
            )
            accum = episode_return_accum[env_index]
            accum[unit_id] = accum.get(unit_id, 0.0) + unit_result["reward"]

        for env_index in range(pool.num_envs):
            env_result = step_result.get(env_index)
            if env_result is None:
                continue
            reset_field = env_result["reset"]
            if reset_field is None:
                state.agents_by_env[env_index] = {a["unitId"]: a for a in env_result["continuing"]}
                continue

            # Natural episode end (win/elimination/truncation) while these units were still
            # alive -- not a real death, so they need a real bootstrap value. Node already handed
            # us their final observation in `reset.bootstrap`; the forward pass happens here.
            bootstrap_obs = [b["observation"] for b in reset_field["bootstrap"]]
            bootstrap_vals = _compute_values(network, device, bootstrap_obs)
            for b, v in zip(reset_field["bootstrap"], bootstrap_vals):
                bootstrap_values[(env_index, env_result["episodeId"], b["unitId"])] = v

            episode_returns.extend(episode_return_accum[env_index].values())
            episode_return_accum[env_index] = {}

            state.episode_ids[env_index] = reset_field["newEpisodeId"]
            state.agents_by_env[env_index] = {a["unitId"]: a for a in reset_field["agents"]}

    # Rollout window ended while some units are still mid-life (never terminated, never hit a
    # mid-rollout reset) -- bootstrap them too, so every open segment resolves.
    for env_index in range(pool.num_envs):
        agents = state.agents_by_env[env_index]
        if not agents:
            continue
        unit_ids = list(agents.keys())
        values = _compute_values(network, device, [agents[u]["observation"] for u in unit_ids])
        for unit_id, v in zip(unit_ids, values):
            bootstrap_values[(env_index, state.episode_ids[env_index], unit_id)] = v

    grouped: dict[tuple[int, int, int], list[_RawRecord]] = {}
    for r in records:
        grouped.setdefault((r.env_index, r.episode_id, r.unit_id), []).append(r)

    steps: list[RolloutStep] = []
    for key, recs in grouped.items():
        terminal = recs[-1].terminated
        bootstrap_value = 0.0 if terminal else bootstrap_values.get(key, 0.0)
        result = compute_gae(
            GaeSegment(
                rewards=[r.reward for r in recs],
                values=[r.value for r in recs],
                bootstrap_value=bootstrap_value,
                terminal=terminal,
            ),
            gamma,
            lam,
        )
        for i, r in enumerate(recs):
            steps.append(
                RolloutStep(
                    obs=r.obs,
                    move_mask=r.move_mask,
                    attack_mask=r.attack_mask,
                    ability_mask=r.ability_mask,
                    move_action=r.move_action,
                    attack_action=r.attack_action,
                    ability_action=r.ability_action,
                    old_log_prob=r.old_log_prob,
                    value=r.value,
                    advantage=result.advantages[i],
                    return_=result.returns[i],
                )
            )

    return RolloutBatch(steps=steps, episode_returns=episode_returns)
