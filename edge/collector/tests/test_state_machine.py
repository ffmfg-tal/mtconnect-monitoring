from datetime import datetime, timezone

from collector.state_machine import StateMachine, normalize_execution


UTC = timezone.utc


def ts(seconds: int) -> datetime:
    return datetime(2026, 4, 20, 14, 0, seconds, tzinfo=UTC)


class TestNormalizeExecution:
    def test_active_passthrough(self):
        assert normalize_execution("ACTIVE") == "ACTIVE"

    def test_feed_hold_passthrough(self):
        assert normalize_execution("FEED_HOLD") == "FEED_HOLD"

    def test_interrupted_passthrough(self):
        assert normalize_execution("INTERRUPTED") == "INTERRUPTED"

    def test_unavailable_becomes_offline(self):
        assert normalize_execution("UNAVAILABLE") == "OFFLINE"

    def test_ready_becomes_stopped(self):
        assert normalize_execution("READY") == "STOPPED"

    def test_program_stopped_becomes_stopped(self):
        assert normalize_execution("PROGRAM_STOPPED") == "STOPPED"

    def test_program_completed_becomes_stopped(self):
        assert normalize_execution("PROGRAM_COMPLETED") == "STOPPED"

    def test_optional_stop_becomes_stopped(self):
        assert normalize_execution("OPTIONAL_STOP") == "STOPPED"

    def test_stopped_passthrough(self):
        assert normalize_execution("STOPPED") == "STOPPED"

    def test_unknown_becomes_offline(self):
        assert normalize_execution("SOMETHING_WEIRD") == "OFFLINE"

    def test_case_insensitive(self):
        assert normalize_execution("active") == "ACTIVE"


class TestStateMachine:
    def test_first_observation_produces_no_closed_interval(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        closed = sm.observe(ts(0), "ACTIVE")
        assert closed == []

    def test_no_state_change_produces_no_closed_interval(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        sm.observe(ts(0), "ACTIVE")
        closed = sm.observe(ts(2), "ACTIVE")
        assert closed == []

    def test_state_change_closes_prior_interval(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        sm.observe(ts(0), "ACTIVE", program="O1234", tool_number=5)
        closed = sm.observe(ts(10), "FEED_HOLD", program="O1234", tool_number=5)
        assert len(closed) == 1
        interval = closed[0]
        assert interval.machine_id == "haas-vf2-1"
        assert interval.state == "ACTIVE"
        assert interval.started_at == ts(0)
        assert interval.ended_at == ts(10)
        assert interval.duration_seconds == 10
        assert interval.program == "O1234"
        assert interval.tool_number == 5

    def test_multiple_transitions_produce_sequential_intervals(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        sm.observe(ts(0), "STOPPED")
        a = sm.observe(ts(5), "ACTIVE")
        b = sm.observe(ts(20), "FEED_HOLD")
        c = sm.observe(ts(30), "ACTIVE")
        assert [i.state for i in a] == ["STOPPED"]
        assert [i.state for i in b] == ["ACTIVE"]
        assert [i.state for i in c] == ["FEED_HOLD"]
        assert a[0].duration_seconds == 5
        assert b[0].duration_seconds == 15
        assert c[0].duration_seconds == 10

    def test_normalizes_raw_mtconnect_values(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        sm.observe(ts(0), "READY")
        closed = sm.observe(ts(3), "ACTIVE")
        assert len(closed) == 1
        assert closed[0].state == "STOPPED"  # READY normalized

    def test_program_tool_recorded_from_state_entry(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        sm.observe(ts(0), "ACTIVE", program="O1", tool_number=1)
        # program/tool change mid-interval should not retroactively rewrite
        sm.observe(ts(5), "ACTIVE", program="O2", tool_number=2)
        closed = sm.observe(ts(10), "STOPPED", program="O2", tool_number=2)
        assert closed[0].program == "O1"
        assert closed[0].tool_number == 1

    def test_current_state_exposed(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        assert sm.current_state is None
        sm.observe(ts(0), "ACTIVE")
        assert sm.current_state == "ACTIVE"

    def test_force_close_produces_final_interval(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        sm.observe(ts(0), "ACTIVE", program="O9")
        interval = sm.close(ts(30))
        assert interval is not None
        assert interval.state == "ACTIVE"
        assert interval.duration_seconds == 30
        assert interval.program == "O9"
        # after close, no open interval
        assert sm.current_state is None

    def test_force_close_with_no_open_interval_returns_none(self):
        sm = StateMachine(machine_id="haas-vf2-1")
        assert sm.close(ts(10)) is None
