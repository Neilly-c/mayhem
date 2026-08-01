"""PPO clipped-surrogate update. Mirrors src/train/ppo.ts. Preserve specific details deliberately
during any future edits: advantages are normalized ONCE per batch, OUTSIDE the epoch loop (easy to
accidentally "fix" into per-epoch normalization) and the value loss defaults to the PPO2-style
clipped MSE (see `PPOConfig.clip_value_loss`).

Unlike the TF.js side, PyTorch's autograd manages tensor memory automatically — there is no
manual-disposal discipline needed here (that was the real correctness risk on the TS side; it
does not carry over).
"""

from __future__ import annotations

import random
from dataclasses import dataclass

import torch
import torch.nn.functional as F

from .action_sampling import evaluate_masked_categorical
from .network import ActorCriticNetwork


@dataclass
class PPOConfig:
    clip_ratio: float = 0.2
    epochs: int = 4
    minibatch_size: int = 256
    value_loss_coef: float = 0.5
    entropy_coef: float = 0.01
    clip_value_loss: bool = True
    learning_rate: float = 3e-4
    max_grad_norm: float | None = None


@dataclass
class RolloutStep:
    obs: list[float]
    move_mask: list[bool]
    attack_mask: list[bool]
    ability_mask: list[bool]
    move_action: int
    attack_action: int
    ability_action: int
    old_log_prob: float
    value: float
    advantage: float
    return_: float


@dataclass
class PpoUpdateStats:
    policy_loss: float
    value_loss: float
    entropy: float
    # "k2" approximate KL (0.5 * mean((newLogProb-oldLogProb)^2)) -- a rough gauge of how far the
    # update moved the policy.
    approx_kl: float
    clip_fraction: float


def run_ppo_update(
    network: ActorCriticNetwork,
    optimizer: torch.optim.Optimizer,
    steps: list[RolloutStep],
    config: PPOConfig,
    device: torch.device,
    rng: random.Random,
) -> PpoUpdateStats:
    n = len(steps)
    if n == 0:
        return PpoUpdateStats(0.0, 0.0, 0.0, 0.0, 0.0)

    obs_t = torch.tensor([s.obs for s in steps], dtype=torch.float32, device=device)
    move_mask_t = torch.tensor([[1.0 if b else 0.0 for b in s.move_mask] for s in steps], dtype=torch.float32, device=device)
    attack_mask_t = torch.tensor(
        [[1.0 if b else 0.0 for b in s.attack_mask] for s in steps], dtype=torch.float32, device=device
    )
    ability_mask_t = torch.tensor(
        [[1.0 if b else 0.0 for b in s.ability_mask] for s in steps], dtype=torch.float32, device=device
    )
    move_actions_t = torch.tensor([s.move_action for s in steps], dtype=torch.long, device=device)
    attack_actions_t = torch.tensor([s.attack_action for s in steps], dtype=torch.long, device=device)
    ability_actions_t = torch.tensor([s.ability_action for s in steps], dtype=torch.long, device=device)
    old_log_prob_t = torch.tensor([s.old_log_prob for s in steps], dtype=torch.float32, device=device)
    old_value_t = torch.tensor([s.value for s in steps], dtype=torch.float32, device=device)
    returns_t = torch.tensor([s.return_ for s in steps], dtype=torch.float32, device=device)

    raw_advantages = [s.advantage for s in steps]
    adv_mean = sum(raw_advantages) / n
    adv_var = sum((a - adv_mean) ** 2 for a in raw_advantages) / n
    adv_std = adv_var**0.5
    advantages_t = torch.tensor(
        [(a - adv_mean) / (adv_std + 1e-8) for a in raw_advantages], dtype=torch.float32, device=device
    )

    accum = {"policy_loss": 0.0, "value_loss": 0.0, "entropy": 0.0, "approx_kl": 0.0, "clip_fraction": 0.0, "weight": 0}

    for _epoch in range(config.epochs):
        order = list(range(n))
        rng.shuffle(order)
        for start in range(0, n, config.minibatch_size):
            idx = order[start : start + config.minibatch_size]
            idx_t = torch.tensor(idx, dtype=torch.long, device=device)

            obs_slice = obs_t[idx_t]
            move_mask_slice = move_mask_t[idx_t]
            attack_mask_slice = attack_mask_t[idx_t]
            ability_mask_slice = ability_mask_t[idx_t]
            move_actions_slice = move_actions_t[idx_t]
            attack_actions_slice = attack_actions_t[idx_t]
            ability_actions_slice = ability_actions_t[idx_t]
            old_log_prob_slice = old_log_prob_t[idx_t]
            old_value_slice = old_value_t[idx_t]
            returns_slice = returns_t[idx_t]
            advantages_slice = advantages_t[idx_t]

            move_logits, attack_logits, ability_logits, value = network(obs_slice)
            move_log_prob, move_entropy = evaluate_masked_categorical(move_logits, move_mask_slice, move_actions_slice)
            attack_log_prob, attack_entropy = evaluate_masked_categorical(
                attack_logits, attack_mask_slice, attack_actions_slice
            )
            ability_log_prob, ability_entropy = evaluate_masked_categorical(
                ability_logits, ability_mask_slice, ability_actions_slice
            )
            new_log_prob = move_log_prob + attack_log_prob + ability_log_prob
            entropy_per_sample = move_entropy + attack_entropy + ability_entropy

            ratio = (new_log_prob - old_log_prob_slice).exp()
            surr1 = ratio * advantages_slice
            clipped_ratio = torch.clamp(ratio, 1 - config.clip_ratio, 1 + config.clip_ratio)
            surr2 = clipped_ratio * advantages_slice
            policy_loss = -torch.min(surr1, surr2).mean()

            value_pred = value.squeeze(-1)
            if config.clip_value_loss:
                delta = torch.clamp(value_pred - old_value_slice, -config.clip_ratio, config.clip_ratio)
                value_clipped = old_value_slice + delta
                loss_unclipped = (value_pred - returns_slice) ** 2
                loss_clipped = (value_clipped - returns_slice) ** 2
                value_loss = torch.max(loss_unclipped, loss_clipped).mean()
            else:
                value_loss = F.mse_loss(value_pred, returns_slice)

            entropy_mean = entropy_per_sample.mean()
            total_loss = policy_loss + value_loss * config.value_loss_coef - entropy_mean * config.entropy_coef

            optimizer.zero_grad()
            total_loss.backward()
            if config.max_grad_norm is not None:
                torch.nn.utils.clip_grad_norm_(network.parameters(), config.max_grad_norm)
            optimizer.step()

            with torch.no_grad():
                approx_kl = 0.5 * ((new_log_prob - old_log_prob_slice) ** 2).mean()
                clip_fraction = ((ratio - 1.0).abs() > config.clip_ratio).float().mean()

            weight = len(idx)
            accum["policy_loss"] += policy_loss.item() * weight
            accum["value_loss"] += value_loss.item() * weight
            accum["entropy"] += entropy_mean.item() * weight
            accum["approx_kl"] += approx_kl.item() * weight
            accum["clip_fraction"] += clip_fraction.item() * weight
            accum["weight"] += weight

    w = max(1, accum["weight"])
    return PpoUpdateStats(
        policy_loss=accum["policy_loss"] / w,
        value_loss=accum["value_loss"] / w,
        entropy=accum["entropy"] / w,
        approx_kl=accum["approx_kl"] / w,
        clip_fraction=accum["clip_fraction"] / w,
    )
