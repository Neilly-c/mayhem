import json
import tempfile
from pathlib import Path

import pytest
import torch

from mayhem_rl.checkpoint import (
    ensure_tfjs_template,
    export_tfjs,
    load_checkpoint,
    make_checkpoint_meta,
    mean_win_rate,
    save_checkpoint,
    set_checkpoint_score,
)
from mayhem_rl.network import ActorCriticNetwork


def test_save_load_round_trip_preserves_forward_pass_output():
    network_config = {"obsDim": 7, "maxVisibleEnemies": 2, "hiddenSizes": [8]}
    net = ActorCriticNetwork(obs_dim=7, max_visible_enemies=2, hidden_sizes=(8,))
    meta = make_checkpoint_meta(iteration=42, network_config=network_config, sim_config={"teamCount": 6})

    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp) / "ckpt"
        save_checkpoint(net, directory, meta)
        assert (directory / "weights.pt").exists()
        assert (directory / "meta.json").exists()

        loaded_net, loaded_meta = load_checkpoint(directory)
        assert loaded_meta == meta

        obs = torch.randn(3, 7)
        with torch.no_grad():
            move1, attack1, ability1, value1 = net(obs)
            move2, attack2, ability2, value2 = loaded_net(obs)
        assert torch.equal(move1, move2)
        assert torch.equal(attack1, attack2)
        assert torch.equal(ability1, ability2)
        assert torch.equal(value1, value2)


def test_make_checkpoint_meta_defaults_score_to_none():
    meta = make_checkpoint_meta(iteration=1, network_config={}, sim_config={})
    assert meta["score"] is None


def test_set_checkpoint_score_patches_meta_json_in_place():
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp) / "ckpt"
        directory.mkdir()
        meta = make_checkpoint_meta(iteration=1, network_config={"obsDim": 1}, sim_config={})
        (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

        set_checkpoint_score(directory, 0.75)

        patched = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
        assert patched["score"] == 0.75
        assert patched["iteration"] == 1  # other fields untouched


def test_mean_win_rate_averages_across_matchups():
    report = {
        "matchups": [
            {"opponentBotKind": "expander", "winRate": 0.4},
            {"opponentBotKind": "guardian", "winRate": 0.8},
        ]
    }
    assert mean_win_rate(report) == pytest.approx(0.6)


def test_mean_win_rate_returns_none_for_no_matchups():
    assert mean_win_rate({"matchups": []}) is None


def test_ensure_tfjs_template_regenerates_when_obs_dim_changes_for_a_reused_template_dir():
    """Regression test: a `--checkpoint-dir` reused across two training runs with different
    `obsDim` (e.g. `env/observation.ts`'s vector length changed between the runs) used to leave a
    stale `model.json` in `_tfjs_template/`, which `export_tfjs` would then silently try to load
    weights into -- crashing deep into the second run with `shape mismatch for trunk_0/kernel`.
    `ensure_tfjs_template` must detect the mismatch (via the `network_config.json` sidecar it
    writes) and regenerate the template rather than reusing the stale one.
    """
    with tempfile.TemporaryDirectory() as tmp:
        template_dir = Path(tmp) / "_tfjs_template"

        old_config = {"obsDim": 7, "maxVisibleEnemies": 2, "hiddenSizes": [8]}
        ensure_tfjs_template(old_config, template_dir)
        assert (template_dir / "model.json").exists()

        # Simulate a later run whose observation vector grew (a real network built with the new
        # obsDim must export cleanly against the *same* template_dir, not crash).
        new_config = {"obsDim": 11, "maxVisibleEnemies": 2, "hiddenSizes": [8]}
        ensure_tfjs_template(new_config, template_dir)

        marker = json.loads((template_dir / "network_config.json").read_text(encoding="utf-8"))
        assert marker == new_config

        net = ActorCriticNetwork(obs_dim=11, max_visible_enemies=2, hidden_sizes=(8,))
        out_dir = Path(tmp) / "export"
        export_tfjs(net, template_dir, out_dir)  # must not raise
        assert (out_dir / "model.json").exists()


def test_ensure_tfjs_template_reuses_an_unchanged_template_without_regenerating():
    with tempfile.TemporaryDirectory() as tmp:
        template_dir = Path(tmp) / "_tfjs_template"
        config = {"obsDim": 5, "maxVisibleEnemies": 1, "hiddenSizes": [8]}

        ensure_tfjs_template(config, template_dir)
        first_mtime = (template_dir / "model.json").stat().st_mtime_ns

        ensure_tfjs_template(config, template_dir)
        second_mtime = (template_dir / "model.json").stat().st_mtime_ns

        assert first_mtime == second_mtime  # not rewritten
