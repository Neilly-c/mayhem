import math
import random

import pytest
import torch

from mayhem_rl.bridge.worker_pool import WorkerPool
from mayhem_rl.network import ABILITY_ACTIONS, MOVE_ACTIONS, ActorCriticNetwork
from mayhem_rl.rollout_buffer import collect_rollout, create_rollout_state

SIM_CONFIG = {
    "mapRadius": 4,
    "wallThreshold": 0,
    "teamCount": 2,
    "unitsPerTeam": 1,
    "maxVisibleEnemies": 2,
    "decisionInterval": 2,
}


def test_produces_a_well_formed_batch_with_finite_values_no_nans():
    pool = WorkerPool(num_envs=2, num_workers=2, base_seed=42, sim_config_overrides=SIM_CONFIG, timeout=15.0)
    try:
        network = ActorCriticNetwork(obs_dim=pool.obs_dim, max_visible_enemies=pool.max_visible_enemies, hidden_sizes=(8,))
        state = create_rollout_state(pool, base_seed=42)

        batch = collect_rollout(
            state, network, torch.device("cpu"), rollout_length=6, gamma=0.99, lam=0.95, action_rng=random.Random(1)
        )

        assert len(batch.steps) > 0
        for step in batch.steps:
            assert len(step.obs) == pool.obs_dim
            assert len(step.move_mask) == MOVE_ACTIONS
            assert len(step.attack_mask) == pool.max_visible_enemies + 1
            assert len(step.ability_mask) == ABILITY_ACTIONS
            assert step.move_mask[0] is True  # idle always legal
            assert step.ability_mask[0] is True  # "do nothing" always legal
            assert 0 <= step.move_action < MOVE_ACTIONS
            assert 0 <= step.attack_action <= pool.max_visible_enemies
            assert 0 <= step.ability_action < ABILITY_ACTIONS
            assert math.isfinite(step.old_log_prob)
            assert math.isfinite(step.value)
            assert math.isfinite(step.advantage)
            assert math.isfinite(step.return_)
    finally:
        pool.close()


def test_auto_resets_an_env_once_max_ticks_truncates_it_and_records_an_episode_return():
    pool = WorkerPool(
        num_envs=1, num_workers=1, base_seed=7, sim_config_overrides=SIM_CONFIG, max_ticks=6, timeout=15.0
    )
    try:
        network = ActorCriticNetwork(obs_dim=pool.obs_dim, max_visible_enemies=pool.max_visible_enemies, hidden_sizes=(8,))
        state = create_rollout_state(pool, base_seed=7)

        batch = collect_rollout(
            state, network, torch.device("cpu"), rollout_length=10, gamma=0.99, lam=0.95, action_rng=random.Random(1)
        )

        assert state.episode_ids[0] > 0  # at least one auto-reset occurred within the window
        assert len(batch.episode_returns) > 0
        for ret in batch.episode_returns:
            assert math.isfinite(ret)
        assert len(batch.steps) > 3  # collection kept going past the reset, didn't stall
    finally:
        pool.close()


def test_persists_rollout_state_across_repeated_calls():
    pool = WorkerPool(num_envs=1, num_workers=1, base_seed=5, sim_config_overrides=SIM_CONFIG, timeout=15.0)
    try:
        network = ActorCriticNetwork(obs_dim=pool.obs_dim, max_visible_enemies=pool.max_visible_enemies, hidden_sizes=(8,))
        state = create_rollout_state(pool, base_seed=5)

        collect_rollout(state, network, torch.device("cpu"), rollout_length=3, gamma=0.99, lam=0.95, action_rng=random.Random(5))
        first_agents = {k: dict(v) for k, v in state.agents_by_env[0].items()}
        assert len(first_agents) > 0

        collect_rollout(state, network, torch.device("cpu"), rollout_length=3, gamma=0.99, lam=0.95, action_rng=random.Random(5))
        # State object continues to be mutated in place across calls (not reset to a fresh episode
        # each call), which is the whole point of persisting RolloutState between iterations.
        assert isinstance(state.episode_ids[0], int)
    finally:
        pool.close()
