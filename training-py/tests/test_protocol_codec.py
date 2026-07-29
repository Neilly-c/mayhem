from pathlib import Path

from mayhem_rl.bridge.protocol import NdjsonDecoder, encode_message

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "sample_messages.ndjson"


def test_encode_message_is_one_json_line_terminated_by_newline():
    message = {"id": 1, "type": "shutdown", "payload": {}}
    encoded = encode_message(message)
    assert encoded.endswith("\n")
    assert encoded.count("\n") == 1


def test_decoder_parses_single_complete_line_in_one_chunk():
    decoder = NdjsonDecoder()
    messages = decoder.push('{"id":1,"type":"shutdown","payload":{}}\n')
    assert messages == [{"id": 1, "type": "shutdown", "payload": {}}]


def test_decoder_parses_multiple_lines_in_one_chunk():
    decoder = NdjsonDecoder()
    messages = decoder.push('{"id":1}\n{"id":2}\n{"id":3}\n')
    assert messages == [{"id": 1}, {"id": 2}, {"id": 3}]


def test_decoder_buffers_partial_line_split_across_chunks():
    decoder = NdjsonDecoder()
    assert decoder.push('{"id":1,"typ') == []
    assert decoder.push('e":"init"}\n') == [{"id": 1, "type": "init"}]


def test_decoder_round_trips_an_encoded_message():
    decoder = NdjsonDecoder()
    message = {
        "id": 5,
        "type": "step",
        "payload": {"envs": [{"localEnvIndex": 0, "actions": [{"unitId": 0, "move": 1, "attack": 0}]}]},
    }
    assert decoder.push(encode_message(message)) == [message]


# --- Cross-language fixture (see src/bridge/__tests__/protocol.fixture.test.ts for the TS side) ---
# The cheapest available guard against the two hand-written NDJSON codecs drifting apart: both
# sides parse the SAME checked-in fixture file and assert the same hardcoded expectations. If the
# fixture's shape ever changes, both this test and its TS counterpart need matching updates.


def test_cross_language_fixture_decodes_as_expected():
    decoder = NdjsonDecoder()
    text = FIXTURE_PATH.read_text(encoding="utf-8")
    messages = decoder.push(text)

    assert len(messages) == 11

    (
        init_req,
        init_res,
        reset_req,
        reset_res,
        step_req,
        step_res,
        resolve_req,
        resolve_res,
        shutdown_req,
        shutdown_res,
        error_res,
    ) = messages

    assert init_req == {
        "id": 1,
        "type": "init",
        "payload": {
            "workerId": 0,
            "numEnvs": 4,
            "baseSeed": 42,
            "simConfigOverrides": {"mapRadius": 8, "teamCount": 6, "unitsPerTeam": 3},
            "maxTicks": 3000,
        },
    }
    assert init_res["result"]["obsDim"] == 370
    assert init_res["result"]["maxVisibleEnemies"] == 6

    assert reset_res["result"]["envs"][0]["agents"][0]["unitId"] == 0
    assert reset_res["result"]["envs"][0]["agents"][0]["actionMask"]["move"] == [True] * 7

    step_result_env = step_res["result"]["envs"][0]
    assert step_result_env["units"][0]["reward"] == 0.5
    assert step_result_env["reset"]["newEpisodeId"] == 1
    assert step_result_env["reset"]["bootstrap"][0]["unitId"] == 0
    assert step_result_env["reset"]["agents"][0]["unitId"] == 5

    assert resolve_res["result"]["simConfig"] == {"mapRadius": 14, "teamCount": 6, "unitsPerTeam": 3}

    assert shutdown_req == {"id": 5, "type": "shutdown", "payload": {}}
    assert shutdown_res == {"id": 5, "ok": True, "result": {}}

    assert error_res == {"id": 6, "ok": False, "error": {"message": "step: env 3 was never reset"}}
