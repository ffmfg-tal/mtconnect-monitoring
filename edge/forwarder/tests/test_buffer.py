import tempfile
from pathlib import Path

import pytest

from forwarder.buffer import ObservationBuffer
from forwarder.streams import Observation


def mk_obs(seq: int, did: str = "exec", val: str = "ACTIVE", cat: str = "EVENT") -> Observation:
    return Observation(
        device_uuid="d1",
        sequence=seq,
        timestamp=f"2026-04-22T10:00:{seq:02d}Z",
        data_item_id=did,
        category=cat,  # type: ignore[arg-type]
        type="EXECUTION",
        sub_type=None,
        value_num=None,
        value_str=val,
        condition_level=None,
        condition_native_code=None,
        condition_severity=None,
        condition_qualifier=None,
    )


@pytest.fixture
def db_path():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d) / "b.sqlite"


async def test_init_creates_schema(db_path: Path):
    buf = ObservationBuffer(db_path)
    await buf.init()
    await buf.close()
    # no crash is the test; sanity-open a second time
    buf2 = ObservationBuffer(db_path)
    await buf2.init()
    await buf2.close()


async def test_append_and_read_unforwarded(db_path: Path):
    buf = ObservationBuffer(db_path)
    await buf.init()
    try:
        await buf.append([mk_obs(1), mk_obs(2)])
        rows = await buf.unforwarded(limit=10)
        assert [r.sequence for r in rows] == [1, 2]
    finally:
        await buf.close()


async def test_mark_forwarded(db_path: Path):
    buf = ObservationBuffer(db_path)
    await buf.init()
    try:
        await buf.append([mk_obs(1), mk_obs(2), mk_obs(3)])
        await buf.mark_forwarded("d1", 2)
        rows = await buf.unforwarded(limit=10)
        assert [r.sequence for r in rows] == [3]
    finally:
        await buf.close()


async def test_idempotent_append(db_path: Path):
    buf = ObservationBuffer(db_path)
    await buf.init()
    try:
        await buf.append([mk_obs(1), mk_obs(2)])
        await buf.append([mk_obs(2), mk_obs(3)])  # 2 is a dup
        rows = await buf.unforwarded(limit=10)
        assert [r.sequence for r in rows] == [1, 2, 3]
    finally:
        await buf.close()


async def test_agent_state_roundtrip(db_path: Path):
    buf = ObservationBuffer(db_path)
    await buf.init()
    try:
        await buf.set_agent_state("d1", instance_id="i1", last_sequence=42)
        state = await buf.get_agent_state("d1")
        assert state == ("i1", 42)
        await buf.set_agent_state("d1", instance_id="i2", last_sequence=100)
        state2 = await buf.get_agent_state("d1")
        assert state2 == ("i2", 100)
    finally:
        await buf.close()
