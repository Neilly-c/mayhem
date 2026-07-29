import math

import pytest
import torch

from mayhem_rl.action_sampling import (
    argmax_masked_categorical,
    evaluate_masked_categorical,
    sample_masked_categorical,
)


def softmax_probs(xs: list[float]) -> list[float]:
    m = max(xs)
    exps = [math.exp(x - m) for x in xs]
    s = sum(exps)
    return [e / s for e in exps]


def softmax_entropy(xs: list[float]) -> float:
    probs = softmax_probs(xs)
    return -sum(p * math.log(p) for p in probs if p > 0)


def test_never_samples_a_masked_out_action_even_with_a_huge_logit():
    logits = torch.tensor([[1.0, 2.0, 3.0, 100.0]])
    mask = torch.tensor([[1.0, 1.0, 1.0, 0.0]])
    for i in range(200):
        gen = torch.Generator().manual_seed(i)
        sample = sample_masked_categorical(logits, mask, generator=gen)
        assert sample.actions.item() != 3
        assert not torch.isnan(sample.log_probs).any()
        assert not torch.isnan(sample.entropy).any()


def test_computes_log_prob_entropy_as_if_masked_action_did_not_exist():
    logits = torch.tensor([[1.0, 2.0, 3.0, 100.0]])
    mask = torch.tensor([[1.0, 1.0, 1.0, 0.0]])
    expected_probs = softmax_probs([1.0, 2.0, 3.0])
    expected_entropy = softmax_entropy([1.0, 2.0, 3.0])

    for action in range(3):
        actions = torch.tensor([action])
        log_probs, entropy = evaluate_masked_categorical(logits, mask, actions)
        assert log_probs.item() == pytest.approx(math.log(expected_probs[action]), abs=1e-4)
        assert entropy.item() == pytest.approx(expected_entropy, abs=1e-4)


def test_masked_action_gets_very_negative_log_prob_not_nan():
    logits = torch.tensor([[1.0, 2.0, 3.0, 100.0]])
    mask = torch.tensor([[1.0, 1.0, 1.0, 0.0]])
    actions = torch.tensor([3])
    log_probs, entropy = evaluate_masked_categorical(logits, mask, actions)
    assert not torch.isnan(log_probs).any()
    assert not torch.isnan(entropy).any()
    assert log_probs.item() < -1000


def test_zero_entropy_and_zero_log_prob_when_only_one_action_is_legal():
    logits = torch.tensor([[5.0, -3.0, 10.0]])
    mask = torch.tensor([[0.0, 1.0, 0.0]])
    actions = torch.tensor([1])
    log_probs, entropy = evaluate_masked_categorical(logits, mask, actions)
    assert log_probs.item() == pytest.approx(0.0, abs=1e-4)
    assert entropy.item() == pytest.approx(0.0, abs=1e-4)


def test_argmax_never_picks_a_masked_out_action():
    logits = torch.tensor([[1.0, 2.0, 3.0, 100.0]])
    mask = torch.tensor([[1.0, 1.0, 1.0, 0.0]])
    action = argmax_masked_categorical(logits, mask)
    assert action.item() == 2  # best legal logit (3.0); index 3 masked despite logit 100


def test_argmax_is_deterministic():
    logits = torch.tensor([[0.1, 0.2, 0.15]])
    mask = torch.tensor([[1.0, 1.0, 1.0]])
    a = argmax_masked_categorical(logits, mask)
    b = argmax_masked_categorical(logits, mask)
    assert a.item() == b.item()


def test_handles_a_batch_of_multiple_rows_independently():
    logits = torch.tensor([[1.0, 2.0, 3.0], [10.0, -10.0, 0.0]])
    mask = torch.tensor([[1.0, 1.0, 1.0], [1.0, 1.0, 0.0]])
    actions = torch.tensor([2, 0])
    log_probs, entropy = evaluate_masked_categorical(logits, mask, actions)

    assert log_probs[0].item() == pytest.approx(math.log(softmax_probs([1.0, 2.0, 3.0])[2]), abs=1e-4)
    assert entropy[0].item() == pytest.approx(softmax_entropy([1.0, 2.0, 3.0]), abs=1e-4)
    assert log_probs[1].item() == pytest.approx(math.log(softmax_probs([10.0, -10.0])[0]), abs=1e-4)
    assert entropy[1].item() == pytest.approx(softmax_entropy([10.0, -10.0]), abs=1e-4)
