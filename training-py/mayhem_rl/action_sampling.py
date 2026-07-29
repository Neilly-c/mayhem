"""Masked-categorical action sampling/evaluation for the move and attack heads. Mirrors
src/train/actionSampling.ts's masking algebra: an additive `(mask-1)*1e9` logit bias before
softmax (float-safe — avoids the `0 * -inf = nan` trap of a raw `-inf` bias). Cross-language RNG
does *not* need to match between the two sides (see the bridge design's RNG decision) — only the
masking *shape* needs to behave identically, which is why the same bias formula is preserved here
even though PyTorch's own sampling RNG is independent of TF.js's.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch
import torch.nn.functional as F

MASK_BIAS = 1e9


def _masked_logits(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    bias = (mask - 1.0) * MASK_BIAS
    return logits + bias


def _entropy_from_log_probs(log_probs: torch.Tensor) -> torch.Tensor:
    probs = log_probs.exp()
    return -(probs * log_probs).sum(dim=-1)


def _gather_log_prob(log_probs: torch.Tensor, actions: torch.Tensor) -> torch.Tensor:
    return log_probs.gather(-1, actions.unsqueeze(-1)).squeeze(-1)


@dataclass
class HeadSample:
    actions: torch.Tensor
    log_probs: torch.Tensor
    entropy: torch.Tensor


def sample_masked_categorical(
    logits: torch.Tensor, mask: torch.Tensor, generator: torch.Generator | None = None
) -> HeadSample:
    """Rollout collection: samples a new action. Used independently for the move/attack heads."""
    masked = _masked_logits(logits, mask)
    log_probs_all = F.log_softmax(masked, dim=-1)
    probs_all = log_probs_all.exp()
    actions = torch.multinomial(probs_all, 1, generator=generator).squeeze(-1)
    log_probs = _gather_log_prob(log_probs_all, actions)
    entropy = _entropy_from_log_probs(log_probs_all)
    return HeadSample(actions=actions, log_probs=log_probs, entropy=entropy)


def evaluate_masked_categorical(
    logits: torch.Tensor, mask: torch.Tensor, actions: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor]:
    """PPO update: re-evaluates an already-chosen action under the current (updated) policy's
    logits, rather than resampling. Used for the PPO ratio `exp(newLogProb - oldLogProb)` and the
    entropy bonus."""
    log_probs_all = F.log_softmax(_masked_logits(logits, mask), dim=-1)
    log_probs = _gather_log_prob(log_probs_all, actions)
    entropy = _entropy_from_log_probs(log_probs_all)
    return log_probs, entropy


def argmax_masked_categorical(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """Deterministic action choice (evaluation/replay): the legal action with the highest logit."""
    return torch.argmax(_masked_logits(logits, mask), dim=-1)
