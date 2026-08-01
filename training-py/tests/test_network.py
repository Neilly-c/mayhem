import torch

from mayhem_rl.network import ABILITY_ACTIONS, MOVE_ACTIONS, ActorCriticNetwork


def test_forward_output_shapes_for_given_config_and_batch_size():
    net = ActorCriticNetwork(obs_dim=12, max_visible_enemies=4, hidden_sizes=(8, 8))
    obs = torch.randn(5, 12)
    move_logits, attack_logits, ability_logits, value = net(obs)
    assert move_logits.shape == (5, MOVE_ACTIONS)
    assert attack_logits.shape == (5, 5)  # max_visible_enemies + 1
    assert ability_logits.shape == (5, ABILITY_ACTIONS)
    assert value.shape == (5, 1)


def test_default_hidden_sizes_used_when_omitted():
    net = ActorCriticNetwork(obs_dim=6, max_visible_enemies=2)
    assert net.hidden_sizes == (256, 256)
    obs = torch.randn(1, 6)
    move_logits, attack_logits, ability_logits, value = net(obs)
    assert move_logits.shape == (1, MOVE_ACTIONS)
    assert attack_logits.shape == (1, 3)
    assert ability_logits.shape == (1, ABILITY_ACTIONS)
    assert value.shape == (1, 1)


def test_named_parameters_expose_trunk_index_and_head_names_for_export_mapping():
    net = ActorCriticNetwork(obs_dim=4, max_visible_enemies=1, hidden_sizes=(8, 8))
    names = dict(net.named_parameters()).keys()
    assert "trunk.0.weight" in names
    assert "trunk.0.bias" in names
    assert "trunk.1.weight" in names
    assert "move_logits.weight" in names
    assert "attack_logits.weight" in names
    assert "ability_logits.weight" in names
    assert "value.weight" in names


def test_forward_is_deterministic_for_fixed_weights_and_input():
    net = ActorCriticNetwork(obs_dim=4, max_visible_enemies=1, hidden_sizes=(8,))
    obs = torch.randn(2, 4)
    with torch.no_grad():
        move1, attack1, ability1, value1 = net(obs)
        move2, attack2, ability2, value2 = net(obs)
    assert torch.equal(move1, move2)
    assert torch.equal(attack1, attack2)
    assert torch.equal(ability1, ability2)
    assert torch.equal(value1, value2)
