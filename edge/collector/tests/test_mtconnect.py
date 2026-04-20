from datetime import datetime, timezone
from pathlib import Path

from collector.mtconnect import parse_current

FIXTURES = Path(__file__).parent / "fixtures"
UTC = timezone.utc


def _load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class TestParseCurrent:
    def test_active_snapshot(self):
        snap = parse_current(_load("haas_current_active.xml"))
        assert snap.device_uuid == "haas-vf2-1"
        assert snap.creation_time == datetime(2026, 4, 20, 14, 0, 30, tzinfo=UTC)
        assert snap.execution == "ACTIVE"
        assert snap.program == "O01234"
        assert snap.tool_number == 7
        assert snap.part_count == 42
        assert snap.active_faults == []
        assert snap.emergency_stop == "ARMED"

    def test_alarm_snapshot(self):
        snap = parse_current(_load("haas_current_alarm.xml"))
        assert snap.execution == "STOPPED"
        assert snap.part_count == 43
        assert len(snap.active_faults) == 1
        fault = snap.active_faults[0]
        assert fault.type == "LOGIC_PROGRAM"
        assert fault.message == "Spindle overload"
        assert fault.native_code == "202"

    def test_unavailable_values_become_none(self):
        snap = parse_current(_load("haas_current_unavailable.xml"))
        assert snap.execution == "UNAVAILABLE"
        assert snap.program is None
        assert snap.tool_number is None
        assert snap.part_count is None

    def test_header_timestamp_parsed_as_utc(self):
        snap = parse_current(_load("haas_current_active.xml"))
        assert snap.creation_time.tzinfo is not None
