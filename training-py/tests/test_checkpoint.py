import json
import tempfile
from pathlib import Path

import pytest
import torch

from mayhem_rl.checkpoint import load_checkpoint, make_checkpoint_meta, mean_win_rate, save_checkpoint, set_checkpoint_score
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
            move1, attack1, value1 = net(obs)
            move2, attack2, value2 = loaded_net(obs)
        assert torch.equal(move1, move2)
        assert torch.equal(attack1, attack2)
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
