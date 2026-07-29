import pytest

from mayhem_rl.gae import GaeSegment, compute_gae

# Same numeric fixtures as src/train/__tests__/gae.test.ts, so the two implementations can be
# cross-checked against literally the same hand-computed expected values.


def test_matches_hand_computed_2_step_example_when_not_terminal():
    result = compute_gae(
        GaeSegment(rewards=[1, 2], values=[0.5, 0.6], bootstrap_value=0.7, terminal=False), 0.9, 0.95
    )
    # t=1: delta = 2 + 0.9*0.7 - 0.6 = 2.03; gae = 2.03
    # t=0: delta = 1 + 0.9*0.6 - 0.5 = 1.04; gae = 1.04 + 0.9*0.95*2.03 = 2.77565
    assert result.advantages[1] == pytest.approx(2.03, abs=1e-10)
    assert result.returns[1] == pytest.approx(2.63, abs=1e-10)
    assert result.advantages[0] == pytest.approx(2.77565, abs=1e-10)
    assert result.returns[0] == pytest.approx(3.27565, abs=1e-10)


def test_ignores_bootstrap_value_and_uses_zero_when_terminal():
    result = compute_gae(
        GaeSegment(rewards=[1, 2], values=[0.5, 0.6], bootstrap_value=0.7, terminal=True), 0.9, 0.95
    )
    # t=1: delta = 2 + 0.9*0 - 0.6 = 1.4; gae = 1.4
    # t=0: delta = 1 + 0.9*0.6 - 0.5 = 1.04; gae = 1.04 + 0.9*0.95*1.4 = 2.237
    assert result.advantages[1] == pytest.approx(1.4, abs=1e-10)
    assert result.returns[1] == pytest.approx(2.0, abs=1e-10)
    assert result.advantages[0] == pytest.approx(2.237, abs=1e-10)
    assert result.returns[0] == pytest.approx(2.737, abs=1e-10)


def test_higher_advantage_when_not_terminal_vs_terminal_for_same_rewards():
    not_terminal = compute_gae(
        GaeSegment(rewards=[1, 2], values=[0.5, 0.6], bootstrap_value=0.7, terminal=False), 0.9, 0.95
    )
    terminal = compute_gae(
        GaeSegment(rewards=[1, 2], values=[0.5, 0.6], bootstrap_value=0.7, terminal=True), 0.9, 0.95
    )
    assert not_terminal.advantages[0] > terminal.advantages[0]


def test_empty_segment_returns_empty_arrays():
    result = compute_gae(GaeSegment(rewards=[], values=[], bootstrap_value=0, terminal=False), 0.9, 0.95)
    assert result.advantages == []
    assert result.returns == []


def test_single_step_segment_reduces_to_one_td_residual():
    result = compute_gae(GaeSegment(rewards=[3], values=[1], bootstrap_value=2, terminal=False), 0.5, 0.8)
    # delta = 3 + 0.5*2 - 1 = 3.0; gae = delta (no recursion at T=1)
    assert result.advantages[0] == pytest.approx(3.0, abs=1e-10)
    assert result.returns[0] == pytest.approx(4.0, abs=1e-10)
