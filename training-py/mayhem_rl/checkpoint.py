"""Checkpoint save/load: PyTorch `state_dict` + a `meta.json` sidecar (same shape as TS's
`CheckpointMeta`: iteration, networkConfig, simConfig, createdAt). `export_tfjs` (converting a
checkpoint into the TF.js format `src/train/checkpoint.ts`'s `loadCheckpoint` can read) lives here
too — see that function's docstring for the conversion design.
"""

from __future__ import annotations

import datetime
import json
import shutil
import struct
import subprocess
from pathlib import Path
from typing import Any

import torch

from .network import ActorCriticNetwork

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TSX_CLI = _REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
_VERIFY_EXPORT_TS = _REPO_ROOT / "src" / "bridge" / "verifyExport.ts"


def ensure_tfjs_template(network_config: dict[str, Any], template_dir: str | Path) -> None:
    """Generates the canonical TF.js template checkpoint (topology + weightsManifest) via
    `src/bridge/verifyExport.ts template` if it doesn't already exist at `template_dir` — a
    cheap random-init call on the TS side. Reused for every subsequent `export_tfjs` call within
    a training run (`networkConfig` is fixed for the whole run; only `mapRadius` varies via
    curriculum, which doesn't touch the network's shape). See `export_tfjs`'s docstring for why
    Python never hand-authors `model.json`.

    A `network_config.json` sidecar records the exact `obsDim`/`maxVisibleEnemies`/`hiddenSizes`
    used to build the cached template, and is checked against the requested `network_config` on
    every call — if it's missing or doesn't match (e.g. `--checkpoint-dir` reused across two runs
    where `env/observation.ts`'s vector length changed, changing `obsDim`), the template is
    regenerated rather than silently reused. Without this check, `export_tfjs` fails deep inside a
    training run with a `shape mismatch for trunk_0/kernel` `ValueError` — the PyTorch checkpoint
    (`weights.pt`, saved just before the TF.js export) is unaffected either way, so `--resume-from`
    that checkpoint recovers cleanly regardless of whether this staleness check catches it.
    """
    template_dir = Path(template_dir)
    hidden_sizes = list(network_config.get("hiddenSizes") or [256, 256])
    normalized_config = {
        "obsDim": network_config["obsDim"],
        "maxVisibleEnemies": network_config["maxVisibleEnemies"],
        "hiddenSizes": hidden_sizes,
    }

    config_marker = template_dir / "network_config.json"
    if (template_dir / "model.json").exists() and config_marker.exists():
        existing_config = json.loads(config_marker.read_text(encoding="utf-8"))
        if existing_config == normalized_config:
            return

    node = shutil.which("node")
    if node is None:
        raise RuntimeError("`node` executable not found on PATH")
    subprocess.run(
        [
            node,
            str(_TSX_CLI),
            str(_VERIFY_EXPORT_TS),
            "template",
            "--dir",
            str(template_dir),
            "--obsDim",
            str(network_config["obsDim"]),
            "--maxVisibleEnemies",
            str(network_config["maxVisibleEnemies"]),
            "--hiddenSizes",
            ",".join(map(str, hidden_sizes)),
        ],
        check=True,
        cwd=_REPO_ROOT,
    )
    config_marker.write_text(json.dumps(normalized_config), encoding="utf-8")


def save_checkpoint(network: ActorCriticNetwork, directory: str | Path, meta: dict[str, Any]) -> None:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    torch.save(network.state_dict(), directory / "weights.pt")
    (directory / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def load_checkpoint(directory: str | Path) -> tuple[ActorCriticNetwork, dict[str, Any]]:
    directory = Path(directory)
    meta = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    network_config = meta["networkConfig"]
    network = ActorCriticNetwork(
        obs_dim=network_config["obsDim"],
        max_visible_enemies=network_config["maxVisibleEnemies"],
        hidden_sizes=tuple(network_config.get("hiddenSizes") or (256, 256)),
    )
    state_dict = torch.load(directory / "weights.pt", map_location="cpu")
    network.load_state_dict(state_dict)
    return network, meta


def make_checkpoint_meta(
    iteration: int,
    network_config: dict[str, Any],
    sim_config: dict[str, Any],
    score: float | None = None,
) -> dict[str, Any]:
    return {
        "iteration": iteration,
        "networkConfig": network_config,
        "simConfig": sim_config,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "score": score,
    }


def set_checkpoint_score(directory: str | Path, score: float | None) -> None:
    """Eval only completes after the checkpoint (and its TF.js export) is already on disk here,
    so the score is patched into meta.json as a follow-up write rather than being known at
    `save_checkpoint` time (unlike the TS pipeline's trainPPO.ts, which evaluates before saving)."""
    directory = Path(directory)
    meta_path = directory / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["score"] = score
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def mean_win_rate(eval_report: dict[str, Any]) -> float | None:
    """全対戦相手の勝率の単純平均。チェックポイントの優劣を1つのスカラーに集約する既定の指標。"""
    matchups = eval_report.get("matchups") or []
    if not matchups:
        return None
    return sum(m["winRate"] for m in matchups) / len(matchups)


def _pytorch_param_for_tfjs_weight(network: ActorCriticNetwork, tfjs_name: str) -> torch.Tensor:
    """Maps a TF.js weight-manifest entry name (e.g. `trunk_0/kernel`, `move_logits/bias`) to the
    matching PyTorch parameter, transposing 2D kernels: `nn.Linear.weight` is `[out, in]`, TF.js's
    `dense` kernel is `[in, out]`."""
    layer_name, kind = tfjs_name.rsplit("/", 1)
    if layer_name.startswith("trunk_"):
        index = int(layer_name.removeprefix("trunk_"))
        module = network.trunk[index]
    elif layer_name == "move_logits":
        module = network.move_logits
    elif layer_name == "attack_logits":
        module = network.attack_logits
    elif layer_name == "ability_logits":
        module = network.ability_logits
    elif layer_name == "value":
        module = network.value
    else:
        raise ValueError(f"unrecognized TF.js weight name: {tfjs_name!r}")

    if kind == "kernel":
        return module.weight.detach().t().contiguous()
    if kind == "bias":
        return module.bias.detach()
    raise ValueError(f"unrecognized TF.js weight kind: {kind!r} (from {tfjs_name!r})")


_DTYPE_STRUCT_CODE = {"float32": "f"}


def export_tfjs(network: ActorCriticNetwork, template_dir: str | Path, out_dir: str | Path) -> None:
    """Converts `network`'s weights into the TF.js on-disk format that
    `src/train/network.ts`'s `ActorCriticModel.load` (via its Node-only IOHandler, see that
    file) can read directly, so `policyDecisionSource.ts`/`replayRecording.ts`/`evaluate.ts` need
    zero changes to consume a Python-trained policy.

    `template_dir` must be a checkpoint directory previously produced by the TS side
    (`ActorCriticModel.build(networkConfig).save(templateDir)`, a cheap random-init call — see
    `src/bridge/verifyExport.ts` / the export-correctness test for how this is produced in
    practice) with a *matching* `NetworkConfig` (same `obsDim`/`maxVisibleEnemies`/hidden sizes).
    We never hand-author `model.json`'s topology — only its `weightsManifest` (name/shape/dtype,
    in on-disk order) is read, to know which PyTorch parameter maps to which byte range.
    """
    template_dir = Path(template_dir)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    model_json = json.loads((template_dir / "model.json").read_text(encoding="utf-8"))
    weight_specs = model_json["weightsManifest"][0]["weights"]

    buffers: list[bytes] = []
    for spec in weight_specs:
        tensor = _pytorch_param_for_tfjs_weight(network, spec["name"])
        expected_shape = list(spec["shape"])
        if list(tensor.shape) != expected_shape:
            raise ValueError(f"shape mismatch for {spec['name']}: expected {expected_shape}, got {list(tensor.shape)}")
        code = _DTYPE_STRUCT_CODE.get(spec["dtype"])
        if code is None:
            raise ValueError(f"unsupported dtype for {spec['name']}: {spec['dtype']}")
        flat = tensor.reshape(-1).tolist()
        buffers.append(struct.pack(f"<{len(flat)}{code}", *flat))

    (out_dir / "weights.bin").write_bytes(b"".join(buffers))
    (out_dir / "model.json").write_text(json.dumps(model_json), encoding="utf-8")
