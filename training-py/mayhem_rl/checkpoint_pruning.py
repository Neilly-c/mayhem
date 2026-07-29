"""1:1 port of `src/train/checkpointPruning.ts`. Keeps the latest checkpoint plus the top-N by
`meta.json`'s `score` field, deleting everything else — see that file's docstrings for the design
rationale (score = mean win rate across baseline-bot matchups, unscored checkpoints rank lowest).
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CheckpointInfo:
    dir: Path
    iteration: int
    score: float | None


def list_checkpoints(checkpoint_dir: str | Path, dir_pattern: re.Pattern[str]) -> list[CheckpointInfo]:
    checkpoint_dir = Path(checkpoint_dir)
    if not checkpoint_dir.exists():
        return []
    checkpoints: list[CheckpointInfo] = []
    for entry in checkpoint_dir.iterdir():
        if not entry.is_dir() or not dir_pattern.match(entry.name):
            continue
        meta_path = entry / "meta.json"
        if not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        checkpoints.append(CheckpointInfo(dir=entry, iteration=meta["iteration"], score=meta.get("score")))
    return checkpoints


def select_checkpoints_to_keep(checkpoints: list[CheckpointInfo], keep_top_n: int) -> set[Path]:
    if not checkpoints:
        return set()
    keep: set[Path] = set()

    latest = max(checkpoints, key=lambda c: c.iteration)
    keep.add(latest.dir)

    by_score_desc = sorted(
        checkpoints, key=lambda c: c.score if c.score is not None else float("-inf"), reverse=True
    )
    for c in by_score_desc[: max(0, keep_top_n)]:
        keep.add(c.dir)

    return keep


def prune_checkpoints(checkpoint_dir: str | Path, dir_pattern: re.Pattern[str], keep_top_n: int) -> list[Path]:
    checkpoints = list_checkpoints(checkpoint_dir, dir_pattern)
    keep = select_checkpoints_to_keep(checkpoints, keep_top_n)
    deleted: list[Path] = []
    for c in checkpoints:
        if c.dir in keep:
            continue
        shutil.rmtree(c.dir)
        deleted.append(c.dir)
    return deleted
