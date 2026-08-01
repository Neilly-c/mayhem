"""Mandatory correctness test (see the bridge design's checkpoint/replay-interop section): no
Python-trained checkpoint should be trusted for eval/replay/deployment on the TS side until this
passes. Builds a small PyTorch model, exports it to the TF.js format via `export_tfjs`, then has
the REAL TS-side load path (`ActorCriticModel.load`, via `src/bridge/verifyExport.ts`) run a
forward pass on fixed inputs -- and checks that output against the same PyTorch model's own
forward pass. Comparing against PyTorch's own forward (rather than a hand-rolled numpy
reimplementation of Linear+ReLU) is the more direct test: it validates the *whole* round trip
(export -> TS load -> TS forward) against the one unambiguous ground truth for what these
weights should produce.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import torch

from mayhem_rl.checkpoint import export_tfjs
from mayhem_rl.network import ActorCriticNetwork

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TSX_CLI = _REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
_VERIFY_EXPORT_TS = _REPO_ROOT / "src" / "bridge" / "verifyExport.ts"


def _node() -> str:
    node = shutil.which("node")
    assert node is not None, "`node` executable not found on PATH"
    return node


def _run_verify_export(*args: str) -> str:
    result = subprocess.run(
        [_node(), str(_TSX_CLI), str(_VERIFY_EXPORT_TS), *args],
        check=True,
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT,
    )
    return result.stdout.strip().splitlines()[-1]


def test_export_tfjs_round_trip_matches_the_original_models_own_forward_pass(tmp_path):
    obs_dim = 4
    max_visible_enemies = 1
    hidden_sizes = (3,)

    net = ActorCriticNetwork(obs_dim=obs_dim, max_visible_enemies=max_visible_enemies, hidden_sizes=hidden_sizes)
    net.eval()

    # 1. TS generates the canonical template (topology + weightsManifest) -- Python never
    #    hand-authors model.json.
    template_dir = tmp_path / "template"
    _run_verify_export(
        "template",
        "--dir",
        str(template_dir),
        "--obsDim",
        str(obs_dim),
        "--maxVisibleEnemies",
        str(max_visible_enemies),
        "--hiddenSizes",
        ",".join(map(str, hidden_sizes)),
    )

    # 2. Python exports this model's actual weights into that template's shape.
    export_dir = tmp_path / "export"
    export_tfjs(net, template_dir, export_dir)
    (export_dir / "meta.json").write_text(
        json.dumps(
            {
                "iteration": 1,
                "networkConfig": {
                    "obsDim": obs_dim,
                    "maxVisibleEnemies": max_visible_enemies,
                    "hiddenSizes": list(hidden_sizes),
                },
                "simConfig": {},
                "createdAt": "2026-01-01T00:00:00.000Z",
            }
        ),
        encoding="utf-8",
    )

    # 3. TS loads the exported checkpoint via the real ActorCriticModel.load path and runs a
    #    forward pass on fixed inputs.
    inputs = [[0.1, -0.2, 0.3, 0.4], [1.0, 0.5, -0.5, 0.0], [0.0, 0.0, 0.0, 0.0]]
    inputs_path = tmp_path / "inputs.json"
    inputs_path.write_text(json.dumps(inputs), encoding="utf-8")

    ts_output = json.loads(_run_verify_export("verify", "--dir", str(export_dir), "--inputs", str(inputs_path)))

    # 4. Reference: the original PyTorch model's own forward pass on the same inputs.
    with torch.no_grad():
        move_ref, attack_ref, ability_ref, value_ref = net(torch.tensor(inputs, dtype=torch.float32))

    assert torch.tensor(ts_output["moveLogits"], dtype=torch.float32).allclose(move_ref, atol=1e-4)
    assert torch.tensor(ts_output["attackLogits"], dtype=torch.float32).allclose(attack_ref, atol=1e-4)
    assert torch.tensor(ts_output["abilityLogits"], dtype=torch.float32).allclose(ability_ref, atol=1e-4)
    assert torch.tensor(ts_output["value"], dtype=torch.float32).allclose(value_ref, atol=1e-4)
