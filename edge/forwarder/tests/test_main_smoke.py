import re
import tempfile
from pathlib import Path

import pytest
from pytest_httpx import HTTPXMock

from forwarder.config import Config
from forwarder.main import run

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def config():
    with tempfile.TemporaryDirectory() as tmp:
        yield Config(
            agent_url="http://agent.test:5000",
            cloud_base_url="http://cloud.test",
            cloud_secret="s",
            buffer_path=str(Path(tmp) / "b.sqlite"),
            poll_interval_s=0.01,
            forward_interval_s=0.01,
            forward_batch_size=500,
        )


async def test_single_cycle_probe_and_forward(
    config: Config, httpx_mock: HTTPXMock, monkeypatch
):
    # /probe
    httpx_mock.add_response(
        url="http://agent.test:5000/probe",
        text=(FIX / "mazak_probe.xml").read_text(encoding="utf-8"),
    )
    # /current
    httpx_mock.add_response(
        url="http://agent.test:5000/current",
        text=(FIX / "mazak_sample_chunk1.xml").read_text(encoding="utf-8"),
    )
    # /sample (one successful call then force stop)
    httpx_mock.add_response(
        url=re.compile(r"http://agent\.test:5000/sample.*"),
        text=(FIX / "mazak_sample_chunk2.xml").read_text(encoding="utf-8"),
        is_reusable=True,
    )
    # cloud
    httpx_mock.add_response(
        url="http://cloud.test/ingest/probe",
        json={"ok": True, "device_uuid": "x"},
        is_reusable=True,
    )
    httpx_mock.add_response(
        url="http://cloud.test/ingest/observations",
        json={"ok": True, "high_water_sequence": 99999999},
        is_reusable=True,
    )

    import asyncio

    async def runner():
        try:
            await asyncio.wait_for(run(config), timeout=0.5)
        except asyncio.TimeoutError:
            pass

    await runner()

    # the buffer should have at least some observations from chunk2
    import aiosqlite

    conn = await aiosqlite.connect(config.buffer_path)
    try:
        cur = await conn.execute("SELECT COUNT(*) FROM observations")
        row = await cur.fetchone()
        assert row is not None
        assert row[0] > 0
    finally:
        await conn.close()
