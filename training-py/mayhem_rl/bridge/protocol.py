"""Node<->Python bridge wire protocol. Mirrors src/bridge/protocol.ts (the canonical definition) —
see that file for the full message-shape documentation. NDJSON over stdio: one JSON object per
line, request (Python->worker) and response (worker->Python) correlated by a monotonic `id`.
"""

from __future__ import annotations

import json
from typing import Any


def encode_message(message: dict[str, Any]) -> str:
    """One JSON line, `\\n`-terminated, ready to write to a subprocess's stdin."""
    return json.dumps(message) + "\n"


class NdjsonDecoder:
    """Line-buffered NDJSON decoder mirroring src/bridge/protocol.ts's `NdjsonDecoder` — a stdout
    chunk read off a pipe can split a line mid-way, so partial lines are buffered across `push`
    calls rather than assumed to always land on a line boundary.
    """

    def __init__(self) -> None:
        self._buffer = ""

    def push(self, chunk: str) -> list[dict[str, Any]]:
        self._buffer += chunk
        lines = self._buffer.split("\n")
        self._buffer = lines.pop()
        return [json.loads(line) for line in lines if line]
