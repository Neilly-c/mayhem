"""Python-side wrapper around `src/bridge/evalAndReplay.ts` — shells out to the TS CLI for
eval/replay so that win-rate scoring, replay recording, and the browser-viewable replay format
are never duplicated in Python. Both require a checkpoint directory that already has the TF.js
export written into it (`checkpoint.export_tfjs`) — inference happens where the sim state lives
(TS), never in this process.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TSX_CLI = _REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
_EVAL_AND_REPLAY_TS = _REPO_ROOT / "src" / "bridge" / "evalAndReplay.ts"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("`node` executable not found on PATH")
    return node


def _run(*args: str) -> dict[str, Any]:
    result = subprocess.run(
        [_node(), str(_TSX_CLI), str(_EVAL_AND_REPLAY_TS), *args],
        check=True,
        capture_output=True,
        text=True,
        cwd=_REPO_ROOT,
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


def evaluate_checkpoint(
    checkpoint_dir: str | Path,
    iteration: int,
    seed_base: int,
    episodes: int = 5,
    opponents: tuple[str, ...] = ("scripted", "decisionTree", "survival"),
) -> dict[str, Any]:
    return _run(
        "eval",
        "--checkpointDir",
        str(checkpoint_dir),
        "--iteration",
        str(iteration),
        "--seedBase",
        str(seed_base),
        "--episodes",
        str(episodes),
        "--opponents",
        ",".join(opponents),
    )


def record_replay_for_checkpoint(
    checkpoint_dir: str | Path,
    iteration: int,
    seed: int,
    opponent: str = "scripted",
    replay_dir: str = "public/replays",
) -> dict[str, Any]:
    return _run(
        "replay",
        "--checkpointDir",
        str(checkpoint_dir),
        "--iteration",
        str(iteration),
        "--seed",
        str(seed),
        "--opponent",
        opponent,
        "--replayDir",
        replay_dir,
    )


def prune_replays(replay_dir: str | Path, keep_iterations: set[int]) -> list[str]:
    """Deletes replay manifest entries (and their files) for iterations not in `keep_iterations` --
    pairs with `checkpoint_pruning.prune_checkpoints` so the browser's replay list only ever shows
    generations that still have a surviving checkpoint. Delegates to `replayWriter.ts`'s
    `pruneReplays` via the `evalAndReplay.ts pruneReplays` subcommand so the manifest format isn't
    duplicated in Python."""
    result = _run(
        "pruneReplays",
        "--replayDir",
        str(replay_dir),
        "--keepIterations",
        ",".join(str(i) for i in sorted(keep_iterations)),
    )
    return result["deleted"]
