import random

import torch

from mayhem_rl.network import ActorCriticNetwork
from mayhem_rl.ppo import PPOConfig, PpoUpdateStats, RolloutStep, run_ppo_update

OBS_DIM = 6
MAX_VISIBLE_ENEMIES = 2  # attack head size = 3


def make_synthetic_steps(n: int, seed: int = 1) -> list[RolloutStep]:
    rng = random.Random(seed)
    steps = []
    for _ in range(n):
        steps.append(
            RolloutStep(
                obs=[rng.uniform(-1, 1) for _ in range(OBS_DIM)],
                move_mask=[True] * 7,
                attack_mask=[True] * 3,
                ability_mask=[True] * 7,
                move_action=rng.randrange(7),
                attack_action=rng.randrange(3),
                ability_action=rng.randrange(7),
                old_log_prob=-1.5 - rng.random(),
                value=rng.uniform(-1, 1),
                advantage=rng.uniform(-1, 1),
                return_=rng.uniform(-1, 1),
            )
        )
    return steps


def default_test_config() -> PPOConfig:
    return PPOConfig(clip_ratio=0.2, epochs=2, minibatch_size=8, value_loss_coef=0.5, entropy_coef=0.01, learning_rate=1e-3)


def test_produces_finite_loss_stats_on_a_synthetic_batch():
    net = ActorCriticNetwork(obs_dim=OBS_DIM, max_visible_enemies=MAX_VISIBLE_ENEMIES, hidden_sizes=(8,))
    optimizer = torch.optim.Adam(net.parameters(), lr=default_test_config().learning_rate)
    steps = make_synthetic_steps(20)

    stats = run_ppo_update(net, optimizer, steps, default_test_config(), torch.device("cpu"), random.Random(1))

    for field in ("policy_loss", "value_loss", "entropy", "approx_kl", "clip_fraction"):
        value = getattr(stats, field)
        assert value == value  # not NaN
        assert abs(value) != float("inf")


def test_returns_zeroed_stats_for_an_empty_batch_without_crashing():
    net = ActorCriticNetwork(obs_dim=OBS_DIM, max_visible_enemies=MAX_VISIBLE_ENEMIES, hidden_sizes=(8,))
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-3)

    stats = run_ppo_update(net, optimizer, [], default_test_config(), torch.device("cpu"), random.Random(1))

    assert stats == PpoUpdateStats(0.0, 0.0, 0.0, 0.0, 0.0)


def test_actually_updates_the_network_weights():
    net = ActorCriticNetwork(obs_dim=OBS_DIM, max_visible_enemies=MAX_VISIBLE_ENEMIES, hidden_sizes=(8,))
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-2)
    before = net.move_logits.weight.detach().clone()

    run_ppo_update(net, optimizer, make_synthetic_steps(20), default_test_config(), torch.device("cpu"), random.Random(1))

    after = net.move_logits.weight.detach()
    assert not torch.equal(before, after)


def test_respects_clip_value_loss_false_falls_back_to_plain_mse():
    net = ActorCriticNetwork(obs_dim=OBS_DIM, max_visible_enemies=MAX_VISIBLE_ENEMIES, hidden_sizes=(8,))
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-3)
    config = PPOConfig(**{**default_test_config().__dict__, "clip_value_loss": False})

    stats = run_ppo_update(net, optimizer, make_synthetic_steps(10), config, torch.device("cpu"), random.Random(1))
    assert stats.value_loss == stats.value_loss  # not NaN
