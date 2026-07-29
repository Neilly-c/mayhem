"""Generalized Advantage Estimation. Pure math, no torch — a direct port of src/train/gae.ts.

One segment = one unit's "life" (a continuous alive stretch within the rollout). A unit dies at
most once, at the very end of its segment, so no per-step `dones` array is needed inside a
segment — only whether the final step was a true termination (`terminal=True`, bootstrap forced
to 0) or not (truncation / still-alive at the rollout-length cutoff — `terminal=False`, uses a
real `bootstrap_value` from one extra critic-only forward pass, computed by the caller).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class GaeSegment:
    rewards: list[float]
    values: list[float]
    bootstrap_value: float
    terminal: bool


@dataclass
class GaeResult:
    advantages: list[float]
    returns: list[float]


def compute_gae(segment: GaeSegment, gamma: float, lam: float) -> GaeResult:
    rewards = segment.rewards
    values = segment.values
    t_len = len(rewards)
    advantages = [0.0] * t_len
    returns = [0.0] * t_len

    v_last = 0.0 if segment.terminal else segment.bootstrap_value
    gae = 0.0
    for t in range(t_len - 1, -1, -1):
        v_next = v_last if t == t_len - 1 else values[t + 1]
        delta = rewards[t] + gamma * v_next - values[t]
        gae = delta + gamma * lam * gae
        advantages[t] = gae
        returns[t] = gae + values[t]

    return GaeResult(advantages=advantages, returns=returns)
