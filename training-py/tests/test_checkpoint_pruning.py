import json
import re
import tempfile
from pathlib import Path

from mayhem_rl.checkpoint_pruning import CheckpointInfo, list_checkpoints, prune_checkpoints, select_checkpoints_to_keep

_DIR_PATTERN = re.compile(r"^py-iter-\d+$")


def _make_checkpoint_dir(root: Path, name: str, iteration: int, score: float | None) -> None:
    directory = root / name
    directory.mkdir(parents=True)
    (directory / "meta.json").write_text(json.dumps({"iteration": iteration, "score": score}), encoding="utf-8")


def test_select_checkpoints_to_keep_always_keeps_the_latest_even_with_the_worst_score():
    checkpoints = [
        CheckpointInfo(dir=Path("a"), iteration=20, score=0.9),
        CheckpointInfo(dir=Path("b"), iteration=40, score=0.1),  # latest, worst score
    ]
    keep = select_checkpoints_to_keep(checkpoints, keep_top_n=1)
    assert Path("b") in keep


def test_select_checkpoints_to_keep_keeps_top_n_by_score_plus_latest():
    checkpoints = [
        CheckpointInfo(dir=Path("a"), iteration=20, score=0.9),
        CheckpointInfo(dir=Path("b"), iteration=40, score=0.2),
        CheckpointInfo(dir=Path("c"), iteration=60, score=0.5),
        CheckpointInfo(dir=Path("d"), iteration=80, score=0.1),  # latest
    ]
    keep = select_checkpoints_to_keep(checkpoints, keep_top_n=2)
    assert keep == {Path("d"), Path("a"), Path("c")}


def test_select_checkpoints_to_keep_treats_none_score_as_lowest_priority():
    checkpoints = [
        CheckpointInfo(dir=Path("a"), iteration=20, score=None),
        CheckpointInfo(dir=Path("b"), iteration=40, score=0.5),
        CheckpointInfo(dir=Path("c"), iteration=60, score=None),  # latest
    ]
    keep = select_checkpoints_to_keep(checkpoints, keep_top_n=1)
    assert keep == {Path("c"), Path("b")}


def test_select_checkpoints_to_keep_empty_input():
    assert select_checkpoints_to_keep([], keep_top_n=3) == set()


def test_list_checkpoints_only_matches_pattern_with_meta_json():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_checkpoint_dir(root, "py-iter-20", 20, 0.3)
        _make_checkpoint_dir(root, "py-iter-40", 40, 0.7)
        (root / "_tfjs_template").mkdir()  # no meta.json, wrong name
        (root / "py-iter-60").mkdir()  # matches pattern, but no meta.json yet

        checkpoints = list_checkpoints(root, _DIR_PATTERN)
        assert sorted(c.iteration for c in checkpoints) == [20, 40]


def test_regression_combined_pattern_sees_both_ts_and_python_checkpoint_dirs():
    """A prior bug scoped train_ppo.py's replay keep-set computation to only `py-iter-*`
    checkpoints (its own pipeline's pattern), so it deleted still-live replays belonging to
    checkpoints the TS pipeline (`iter-*`) still had. The fix is a combined pattern covering both;
    this guards the fix stays in place."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_checkpoint_dir(root, "iter-20", 20, 0.5)
        _make_checkpoint_dir(root, "py-iter-880", 880, 0.6)
        _make_checkpoint_dir(root, "py-iter-1120", 1120, 0.4)

        any_pattern = re.compile(r"^(py-)?iter-\d+$")
        checkpoints = list_checkpoints(root, any_pattern)
        assert sorted(c.iteration for c in checkpoints) == [20, 880, 1120]


def test_prune_checkpoints_deletes_everything_outside_the_keep_set():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _make_checkpoint_dir(root, "py-iter-20", 20, 0.9)
        _make_checkpoint_dir(root, "py-iter-40", 40, 0.2)
        _make_checkpoint_dir(root, "py-iter-60", 60, 0.5)
        _make_checkpoint_dir(root, "py-iter-80", 80, 0.1)  # latest, worst score

        deleted = prune_checkpoints(root, _DIR_PATTERN, keep_top_n=1)

        assert (root / "py-iter-80").exists()  # latest, always kept
        assert (root / "py-iter-20").exists()  # best score, kept
        assert not (root / "py-iter-40").exists()
        assert not (root / "py-iter-60").exists()
        assert sorted(deleted) == sorted([root / "py-iter-40", root / "py-iter-60"])


def test_prune_checkpoints_missing_directory_is_a_noop():
    assert prune_checkpoints(Path(tempfile.gettempdir()) / "mayhem-does-not-exist", _DIR_PATTERN, keep_top_n=3) == []
