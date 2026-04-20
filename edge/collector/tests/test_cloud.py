from datetime import datetime, timezone

import httpx
import pytest
import respx

from collector.cloud import CloudClient, EventIn, RollupMinuteIn, StateIntervalIn


UTC = timezone.utc
BASE = "https://collector.example.com"
SECRET = "test-shared-secret"


@pytest.fixture
async def client():
    async with CloudClient(base_url=BASE, shared_secret=SECRET) as c:
        yield c


@respx.mock
async def test_post_events_sends_auth_header_and_body(client: CloudClient):
    route = respx.post(f"{BASE}/ingest/events").mock(
        return_value=httpx.Response(200, json={"inserted": 1})
    )
    await client.post_events(
        [
            EventIn(
                machine_id="haas-vf2-1",
                ts="2026-04-20T14:00:00Z",
                kind="program_change",
                severity="info",
                payload={"to": "O01234"},
            )
        ]
    )
    assert route.called
    req = route.calls[0].request
    assert req.headers["X-Edge-Secret"] == SECRET
    body = req.content.decode()
    assert "program_change" in body
    assert "O01234" in body


@respx.mock
async def test_post_state_intervals(client: CloudClient):
    route = respx.post(f"{BASE}/ingest/state").mock(
        return_value=httpx.Response(200, json={"inserted": 1})
    )
    await client.post_state(
        [
            StateIntervalIn(
                machine_id="haas-vf2-1",
                state="ACTIVE",
                started_at="2026-04-20T14:00:00Z",
                ended_at="2026-04-20T14:05:00Z",
                duration_seconds=300,
                program="O01234",
                tool_number=7,
            )
        ]
    )
    assert route.called


@respx.mock
async def test_post_rollups(client: CloudClient):
    route = respx.post(f"{BASE}/ingest/rollups").mock(
        return_value=httpx.Response(200, json={"inserted": 1})
    )
    await client.post_rollups(
        [
            RollupMinuteIn(
                machine_id="haas-vf2-1",
                minute_bucket="2026-04-20T14:00:00Z",
                active_seconds=60,
                feed_hold_seconds=0,
                stopped_seconds=0,
                interrupted_seconds=0,
                offline_seconds=0,
                part_count_delta=1,
                program="O01234",
                tool_number=7,
            )
        ]
    )
    assert route.called


@respx.mock
async def test_empty_batch_is_noop(client: CloudClient):
    route = respx.post(f"{BASE}/ingest/events")
    await client.post_events([])
    assert not route.called


@respx.mock
async def test_4xx_raises(client: CloudClient):
    respx.post(f"{BASE}/ingest/events").mock(
        return_value=httpx.Response(401, json={"error": "unauthorized"})
    )
    with pytest.raises(httpx.HTTPStatusError):
        await client.post_events(
            [
                EventIn(
                    machine_id="haas-vf2-1",
                    ts="2026-04-20T14:00:00Z",
                    kind="offline",
                    severity="fault",
                )
            ]
        )
