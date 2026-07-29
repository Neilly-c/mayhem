"""Spawns and manages a pool of Node `envWorker.ts` subprocesses, sharding the total env pool
across them for real multi-core parallelism. Node/JS is single-threaded per process, so
parallelism for the JS-side simulation stepping comes from multiple OS *processes*, not from
multiple threads inside one — this is the whole reason the pool exists rather than a single
worker.

Per the bridge's non-negotiable constraint (see the design plan / src/bridge/envWorker.ts's
header comment): no forward/backward pass ever happens inside a Node worker. Workers are pure,
stateless-per-call simulation servers; all learning-algorithm logic (this file's caller,
rollout_buffer.py) lives in Python.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

DEFAULT_TIMEOUT_SECONDS = 30.0

# training-py/mayhem_rl/bridge/worker_pool.py -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TSX_CLI = _REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
_WORKER_ENTRY = _REPO_ROOT / "src" / "bridge" / "envWorker.ts"


class WorkerTimeoutError(RuntimeError):
    """A worker did not respond within the configured timeout. Treated as fatal in v1 — no
    mid-run worker restart/recovery, since reconciling GAE segment bookkeeping for whatever envs
    were mid-flight on a restarted worker is real added complexity for a failure mode that should
    be rare (revisit only if it proves to matter in practice)."""

    def __init__(self, worker_id: int, timeout: float) -> None:
        super().__init__(f"worker {worker_id} did not respond within {timeout}s")
        self.worker_id = worker_id


class BridgeError(RuntimeError):
    """Raised when a worker returns an {ok: false} response (e.g. an exception inside envWorker.ts's
    request handler)."""

    def __init__(self, worker_id: int, message: str, stack: str | None) -> None:
        super().__init__(f"worker {worker_id} error: {message}")
        self.worker_id = worker_id
        self.stack = stack


def _find_node() -> str:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("`node` executable not found on PATH; required to spawn envWorker.ts subprocesses")
    return node


def _popen_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = dict(
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    if sys.platform == "win32":
        # No POSIX process groups on Windows; rely on the explicit shutdown/terminate/kill chain
        # in close() rather than Ctrl+C signal propagation, which is unreliable for child
        # `node.exe` processes here. See the plan's Windows-specific note (manual verification:
        # kill the Python process mid-run, confirm no orphaned node.exe in Task Manager).
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return kwargs


class _WorkerProcess:
    """Owns one Node subprocess, a background stdout-reader thread, and pending-response
    bookkeeping. v1 is synchronous per worker (one in-flight request at a time), matching the
    protocol's own design."""

    def __init__(self, worker_id: int, timeout: float, node_path: str) -> None:
        self.worker_id = worker_id
        self.timeout = timeout
        self._next_id = 1
        self._responses: "queue.Queue[dict[str, Any]]" = queue.Queue()

        self._proc = subprocess.Popen(
            [node_path, str(_TSX_CLI), str(_WORKER_ENTRY)], **_popen_kwargs()
        )

        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _read_loop(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self._responses.put(json.loads(line))
            except json.JSONDecodeError:
                # Defensive: a stray non-protocol line (shouldn't happen — the worker reserves
                # stdout exclusively for protocol frames) must not crash the reader thread.
                continue

    def _drain_stderr(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            sys.stderr.write(f"[worker {self.worker_id}] {line}")

    def send(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert self._proc.stdin is not None
        request_id = self._next_id
        self._next_id += 1
        self._proc.stdin.write(json.dumps({"id": request_id, "type": msg_type, "payload": payload}) + "\n")
        self._proc.stdin.flush()

        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise WorkerTimeoutError(self.worker_id, self.timeout)
            try:
                msg = self._responses.get(timeout=remaining)
            except queue.Empty as exc:
                raise WorkerTimeoutError(self.worker_id, self.timeout) from exc
            if msg.get("id") != request_id:
                # v1's protocol is strictly synchronous per worker, so this shouldn't happen; keep
                # waiting rather than silently accepting a mismatched response.
                continue
            if not msg.get("ok", False):
                error = msg.get("error", {})
                raise BridgeError(self.worker_id, error.get("message", "unknown error"), error.get("stack"))
            return msg["result"]

    def close(self, grace_seconds: float = 5.0) -> None:
        try:
            if self._proc.poll() is None:
                self.send("shutdown", {})
        except Exception:
            pass  # already dying/dead or unresponsive; fall through to the terminate/kill chain
        try:
            self._proc.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()


def _run_parallel(jobs: list[Callable[[], dict[str, Any]]]) -> list[dict[str, Any]]:
    """Runs each zero-arg job on its own thread, waits for all, and re-raises the first exception
    only after every thread has finished (so one worker's failure doesn't abandon the others
    mid-flight)."""
    results: list[dict[str, Any] | None] = [None] * len(jobs)
    errors: list[BaseException | None] = [None] * len(jobs)

    def run(i: int) -> None:
        try:
            results[i] = jobs[i]()
        except BaseException as exc:  # noqa: BLE001 - deliberately broad; re-raised below
            errors[i] = exc

    threads = [threading.Thread(target=run, args=(i,)) for i in range(len(jobs))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for err in errors:
        if err is not None:
            raise err
    return results  # type: ignore[return-value]


class WorkerPool:
    """Owns `num_workers` Node worker subprocesses, each holding a static shard of the total
    `num_envs` envs (sharded once at startup — env cost is roughly uniform across shards, so
    static assignment is simplest and matches the `SubprocVecEnv`-style precedent this design is
    based on). Exposes `reset`/`step` keyed by *global* env index; callers never need to know
    which worker owns which env.
    """

    def __init__(
        self,
        num_envs: int,
        num_workers: int | None = None,
        base_seed: int = 0,
        sim_config_overrides: dict[str, Any] | None = None,
        reward_config_overrides: dict[str, Any] | None = None,
        max_ticks: int | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if num_envs <= 0:
            raise ValueError("num_envs must be positive")

        self.num_envs = num_envs
        self.num_workers = max(1, min(num_workers or (os.cpu_count() or 2) - 1, num_envs))
        self.base_seed = base_seed
        self.timeout = timeout

        node_path = _find_node()

        # Static global-index -> (worker, local-index-within-worker) shard assignment, and its
        # inverse (worker -> ordered list of global indices), computed once.
        self._env_to_worker: list[int] = []
        self._env_to_local: list[int] = []
        self._worker_to_globals: list[list[int]] = [[] for _ in range(self.num_workers)]
        for global_index in range(num_envs):
            worker_index = global_index % self.num_workers
            local_index = len(self._worker_to_globals[worker_index])
            self._env_to_worker.append(worker_index)
            self._env_to_local.append(local_index)
            self._worker_to_globals[worker_index].append(global_index)

        # Fail fast on startup: if any worker's init handshake doesn't come back, tear down
        # whatever already started rather than silently proceeding with a smaller/desynced pool.
        self._workers: list[_WorkerProcess] = []
        try:
            self._workers = [_WorkerProcess(i, timeout, node_path) for i in range(self.num_workers)]
            init_results = _run_parallel(
                [
                    (
                        lambda i=i: self._workers[i].send(
                            "init",
                            {
                                "workerId": i,
                                "numEnvs": len(self._worker_to_globals[i]),
                                "baseSeed": base_seed,
                                "simConfigOverrides": sim_config_overrides or {},
                                "rewardConfigOverrides": reward_config_overrides,
                                "maxTicks": max_ticks,
                            },
                        )
                    )
                    for i in range(self.num_workers)
                ]
            )
        except BaseException:
            self._close_workers()
            raise

        self.obs_dim: int = init_results[0]["obsDim"]
        self.max_visible_enemies: int = init_results[0]["maxVisibleEnemies"]

    def reset(self, seeds: dict[int, int]) -> dict[int, dict[str, Any]]:
        """seeds: {global_env_index: seed}. Returns {global_env_index: {episodeId, agents}}."""
        by_worker = self._group_by_worker(seeds, lambda seed: seed)
        involved = sorted(by_worker.keys())
        results = _run_parallel(
            [
                (
                    lambda wi=wi: self._workers[wi].send(
                        "reset",
                        {"envs": [{"localEnvIndex": self._env_to_local[g], "seed": s} for g, s in by_worker[wi]]},
                    )
                )
                for wi in involved
            ]
        )
        return self._merge_env_results(involved, results)

    def step(self, actions: dict[int, list[dict[str, Any]]]) -> dict[int, dict[str, Any]]:
        """actions: {global_env_index: [{unitId, move, attack}, ...]}. Returns {global_env_index:
        step result dict} — see src/bridge/protocol.ts's `StepResultEnv` for the exact shape
        (episodeId/units/continuing/reset)."""
        by_worker = self._group_by_worker(actions, lambda a: a)
        involved = sorted(by_worker.keys())
        results = _run_parallel(
            [
                (
                    lambda wi=wi: self._workers[wi].send(
                        "step",
                        {
                            "envs": [
                                {"localEnvIndex": self._env_to_local[g], "actions": a} for g, a in by_worker[wi]
                            ]
                        },
                    )
                )
                for wi in involved
            ]
        )
        return self._merge_env_results(involved, results)

    def resolve_sim_config(self, iteration: int) -> dict[str, Any]:
        """Asks worker 0 (any worker gives the same answer — it's a pure function of `iteration`)
        rather than porting `curriculum.ts`'s mapRadius table to Python, keeping one source of
        truth and avoiding drift."""
        result = self._workers[0].send("resolveSimConfig", {"iteration": iteration})
        return result["simConfig"]

    def close(self) -> None:
        self._close_workers()

    def _close_workers(self) -> None:
        for w in self._workers:
            w.close()

    def _group_by_worker(self, items: dict[int, Any], _identity: Callable[[Any], Any]) -> dict[int, list[tuple[int, Any]]]:
        grouped: dict[int, list[tuple[int, Any]]] = {}
        for global_index, value in items.items():
            worker_index = self._env_to_worker[global_index]
            grouped.setdefault(worker_index, []).append((global_index, value))
        return grouped

    def _merge_env_results(self, worker_indices: list[int], results: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
        out: dict[int, dict[str, Any]] = {}
        for worker_index, result in zip(worker_indices, results):
            globals_for_worker = self._worker_to_globals[worker_index]
            for env_result in result["envs"]:
                global_index = globals_for_worker[env_result["localEnvIndex"]]
                out[global_index] = env_result
        return out
