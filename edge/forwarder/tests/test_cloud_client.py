import pytest
from pytest_httpx import HTTPXMock

from forwarder.cloud_client import CloudClient
from forwarder.probe import DataItem, Device, ProbeResult
from forwarder.streams import Observation


def mk_obs(seq: int) -> Observation:
    return Observation(
        device_uuid="d1",
        sequence=seq,
        timestamp=f"2026-04-22T10:00:{seq:02d}Z",
        data_item_id="exec",
        category="EVENT",
        type="EXECUTION",
        sub_type=None,
        value_num=None,
        value_str="ACTIVE",
        condition_level=None,
        condition_native_code=None,
        condition_severity=None,
        condition_qualifier=None,
    )


async def test_post_probe_sends_auth_header(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://cloud.test/ingest/probe",
        method="POST",
        json={"ok": True, "device_uuid": "d1"},
    )
    client = CloudClient("http://cloud.test", "secret")
    result = await client.post_probe(
        ProbeResult(
            instance_id="i1",
            schema_version="2.7",
            creation_time="2026-04-22T10:00:00Z",
            devices=[Device(uuid="d1", name="Haas", model="VF-2")],
        ),
        "<?xml?>",
        "d1",
    )
    assert result["ok"] is True
    req = httpx_mock.get_requests()[0]
    assert req.headers["X-Edge-Secret"] == "secret"
    await client.close()


async def test_post_observations_returns_high_water(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://cloud.test/ingest/observations",
        method="POST",
        json={"ok": True, "high_water_sequence": 10},
    )
    client = CloudClient("http://cloud.test", "secret")
    result = await client.post_observations("d1", "i1", [mk_obs(i) for i in range(1, 11)])
    assert result["high_water_sequence"] == 10
    await client.close()


async def test_post_observations_raises_on_4xx(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://cloud.test/ingest/observations",
        method="POST",
        status_code=400,
        json={"error": "bad"},
    )
    client = CloudClient("http://cloud.test", "secret")
    with pytest.raises(Exception):
        await client.post_observations("d1", "i1", [mk_obs(1)])
    await client.close()
