"""Minimal stdout + optional JSONL-append logger. Mirrors src/train/logger.ts's one-JSON-line-per-
event format so `tail -f` habits transfer between the TS and Python trainers' logs. No new deps
(TensorBoard etc. are out of scope, per the bridge design)."""

from __future__ import annotations

import datetime
import json
from pathlib import Path
from typing import Any


class Logger:
    def __init__(self, log_path: str | Path | None = None) -> None:
        self._log_path = Path(log_path) if log_path else None

    def log(self, event: dict[str, Any]) -> None:
        line = json.dumps({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(), **event})
        print(line)
        if self._log_path is not None:
            with open(self._log_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
