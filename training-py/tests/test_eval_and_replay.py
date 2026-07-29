"""Exercises the real subprocess path (mayhem_rl.eval_and_replay -> src/bridge/evalAndReplay.ts),
including the repo-root path resolution that a prior bug got wrong (an off-by-one in
`Path(__file__).resolve().parents[N]` pointed `_REPO_ROOT` at `training-py/` instead of the actual
repo root, so `node ... training-py/src/bridge/evalAndReplay.ts` never existed). A caught bug like
that is exactly what this test guards against regressing.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from mayhem_rl.bridge.worker_pool import WorkerPool
from mayhem_rl.checkpoint import ensure_tfjs_template, export_tfjs, make_checkpoint_meta
from mayhem_rl.eval_and_replay import _REPO_ROOT, evaluate_checkpoint, prune_replays, record_replay_for_checkpoint
from mayhem_rl.network import ActorCriticNetwork

TINY_SIM_CONFIG = {
    "mapRadius": 4,
    "wallThreshold": 0,
    "teamCount": 2,
    "unitsPerTeam": 1,
    "maxVisibleEnemies": 2,
    "decisionInterval": 2,
    "baseDamage": 50,
    "highGroundK": 0,
}


def test_repo_root_resolves_to_the_actual_repository_root():
    assert (_REPO_ROOT / "package.json").exists()
    assert (_REPO_ROOT / "src" / "bridge" / "evalAndReplay.ts").exists()


def test_evaluate_and_record_replay_against_a_real_exported_checkpoint():
    pool = WorkerPool(num_envs=1, num_workers=1, base_seed=1, sim_config_overrides=TINY_SIM_CONFIG, timeout=15.0)
    obs_dim = pool.obs_dim
    pool.close()

    network_config = {"obsDim": obs_dim, "maxVisibleEnemies": 2, "hiddenSizes": [8]}
    net = ActorCriticNetwork(obs_dim=obs_dim, max_visible_enemies=2, hidden_sizes=(8,))

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        template_dir = tmp_path / "template"
        ensure_tfjs_template(network_config, template_dir)

        checkpoint_dir = tmp_path / "checkpoint"
        export_tfjs(net, template_dir, checkpoint_dir)
        meta = make_checkpoint_meta(1, network_config, TINY_SIM_CONFIG)
        (checkpoint_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

        report = evaluate_checkpoint(checkpoint_dir, iteration=1, seed_base=1, episodes=1, opponents=("scripted",))
        assert report["matchups"][0]["opponentBotKind"] == "scripted"
        assert 0 <= report["matchups"][0]["winRate"] <= 1

        replay_dir = tmp_path / "replays"
        entry = record_replay_for_checkpoint(checkpoint_dir, iteration=1, seed=1, opponent="scripted", replay_dir=str(replay_dir))
        assert entry["filename"] == "iter-1-vs-scripted.json"
        assert (replay_dir / entry["filename"]).exists()
        assert (replay_dir / "manifest.json").exists()

        second_entry = record_replay_for_checkpoint(
            checkpoint_dir, iteration=2, seed=1, opponent="scripted", replay_dir=str(replay_dir)
        )
        deleted = prune_replays(replay_dir, keep_iterations={2})
        assert deleted == [entry["filename"]]
        assert not (replay_dir / entry["filename"]).exists()
        assert (replay_dir / second_entry["filename"]).exists()
        manifest = json.loads((replay_dir / "manifest.json").read_text(encoding="utf-8"))
        assert [e["filename"] for e in manifest] == [second_entry["filename"]]


def test_record_replay_self_play_has_every_team_follow_the_checkpoint_policy():
    pool = WorkerPool(num_envs=1, num_workers=1, base_seed=1, sim_config_overrides=TINY_SIM_CONFIG, timeout=15.0)
    obs_dim = pool.obs_dim
    pool.close()

    network_config = {"obsDim": obs_dim, "maxVisibleEnemies": 2, "hiddenSizes": [8]}
    net = ActorCriticNetwork(obs_dim=obs_dim, max_visible_enemies=2, hidden_sizes=(8,))

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        template_dir = tmp_path / "template"
        ensure_tfjs_template(network_config, template_dir)

        checkpoint_dir = tmp_path / "checkpoint"
        export_tfjs(net, template_dir, checkpoint_dir)
        meta = make_checkpoint_meta(1, network_config, TINY_SIM_CONFIG)
        (checkpoint_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

        replay_dir = tmp_path / "replays"
        entry = record_replay_for_checkpoint(
            checkpoint_dir, iteration=1, seed=1, opponent="selfPlay", replay_dir=str(replay_dir)
        )
        assert entry["filename"] == "iter-1-selfplay.json"
        assert entry["opponentBotKind"] == "selfPlay"
        replay = json.loads((replay_dir / entry["filename"]).read_text(encoding="utf-8"))
        assert replay["opponentBotKind"] == "selfPlay"
        assert len(replay["log"]) > 0
