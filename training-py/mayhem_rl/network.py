"""Shared actor-critic network. Mirrors src/train/network.ts's `ActorCriticModel`: a shared MLP
trunk feeding three heads (move logits, attack logits, value). All teams/units share ONE policy
(self-play via weight sharing, see requirements.md §11.1).

The trunk is an `nn.ModuleList` of `nn.Linear` layers rather than named `trunk_0`/`trunk_1`
attributes (not valid Python identifiers with that separator) — `checkpoint.py`'s `export_tfjs`
is what maps `trunk.{i}.weight`/`trunk.{i}.bias` to TF.js's `trunk_{i}/kernel`/`trunk_{i}/bias`
naming, so the two sides don't need identical attribute spelling, just a documented mapping.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

MOVE_ACTIONS = 7
DEFAULT_HIDDEN_SIZES = (256, 256)


class ActorCriticNetwork(nn.Module):
    def __init__(self, obs_dim: int, max_visible_enemies: int, hidden_sizes: tuple[int, ...] | None = None):
        super().__init__()
        hidden_sizes = tuple(hidden_sizes) if hidden_sizes else DEFAULT_HIDDEN_SIZES
        self.obs_dim = obs_dim
        self.max_visible_enemies = max_visible_enemies
        self.hidden_sizes = hidden_sizes

        self.trunk = nn.ModuleList()
        in_features = obs_dim
        for size in hidden_sizes:
            self.trunk.append(nn.Linear(in_features, size))
            in_features = size

        self.move_logits = nn.Linear(in_features, MOVE_ACTIONS)
        self.attack_logits = nn.Linear(in_features, max_visible_enemies + 1)
        self.value = nn.Linear(in_features, 1)

    def forward(self, obs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        x = obs
        for layer in self.trunk:
            x = F.relu(layer(x))
        return self.move_logits(x), self.attack_logits(x), self.value(x)
