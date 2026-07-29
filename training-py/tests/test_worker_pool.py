import pytest

from mayhem_rl.bridge.worker_pool import WorkerPool

TINY_CONFIG = {
    "mapRadius": 4,
    "wallThreshold": 0,
    "teamCount": 2,
    "unitsPerTeam": 1,
    "maxVisibleEnemies": 2,
    "decisionInterval": 2,
}


@pytest.fixture
def pool():
    p = WorkerPool(num_envs=4, num_workers=2, base_seed=1, sim_config_overrides=TINY_CONFIG, timeout=15.0)
    yield p
    p.close()


def test_init_measures_obs_dim_and_max_visible_enemies(pool: WorkerPool):
    assert pool.obs_dim > 0
    assert pool.max_visible_enemies == 2


def test_reset_returns_agents_for_every_requested_env_sharded_across_workers(pool: WorkerPool):
    result = pool.reset({0: 10, 1: 11, 2: 12, 3: 13})
    assert set(result.keys()) == {0, 1, 2, 3}
    for global_index, env_result in result.items():
        assert env_result["episodeId"] == 0
        assert len(env_result["agents"]) == 2  # teamCount:2 * unitsPerTeam:1
        for agent in env_result["agents"]:
            assert len(agent["observation"]) == pool.obs_dim
            assert len(agent["actionMask"]["move"]) == 7


def test_step_advances_every_env_and_merges_results_back_to_global_indices(pool: WorkerPool):
    reset_result = pool.reset({0: 10, 1: 11, 2: 12, 3: 13})

    actions = {
        global_index: [{"unitId": a["unitId"], "move": 0, "attack": 0} for a in env["agents"]]
        for global_index, env in reset_result.items()
    }
    step_result = pool.step(actions)

    assert set(step_result.keys()) == {0, 1, 2, 3}
    for env_result in step_result.values():
        assert len(env_result["units"]) == 2
        for unit in env_result["units"]:
            assert isinstance(unit["reward"], (int, float))
            assert isinstance(unit["terminated"], bool)


def test_resolve_sim_config_matches_across_workers(pool: WorkerPool):
    result = pool.resolve_sim_config(0)
    assert result["teamCount"] == 6
    assert result["unitsPerTeam"] == 3


def test_partial_reset_only_touches_the_requested_envs(pool: WorkerPool):
    first = pool.reset({0: 1, 1: 2, 2: 3, 3: 4})
    # Advance env 0 a few ticks so its state differs from a fresh reset.
    actions = {0: [{"unitId": a["unitId"], "move": 0, "attack": 0} for a in first[0]["agents"]]}
    pool.step(actions)

    # Resetting only env 2 must not raise and must return exactly that env.
    second = pool.reset({2: 99})
    assert set(second.keys()) == {2}
    assert second[2]["episodeId"] == 0
