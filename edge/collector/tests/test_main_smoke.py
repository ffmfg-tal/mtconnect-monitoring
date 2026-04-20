"""End-to-end smoke test: fake MTConnect agent + mocked cloud, drive one poll."""

from __future__ import annotations

from pathlib import Path

import httpx
import respx

from collector.cloud import CloudClient
from collector.main import LoopState, Settings, run_once
from collector.rollups import MinuteAccumulator
from collector.state_machine import StateMachine

FIXTURES = Path(__file__).parent / "fixtures"


def _settings() -> Settings:
    return Settings(
        agent_url="http://fake-agent.local:8082",
        machine_id="haas-vf2-1",
        cloud_base_url="https://cloud.example.com",
        shared_secret="smoke-secret",
        poll_seconds=0.05,
    )


def _fresh_state(machine_id: str) -> LoopState:
    return LoopState(
        sm=StateMachine(machine_id),
        acc=MinuteAccumulator(machine_id),
    )


@respx.mock
async def test_first_poll_posts_program_and_tool_change_events():
    respx.get("http://fake-agent.local:8082/current").mock(
        return_value=httpx.Response(
            200, content=(FIXTURES / "haas_current_active.xml").read_bytes()
        )
    )
    events_route = respx.post("https://cloud.example.com/ingest/events").mock(
        return_value=httpx.Response(200, json={"inserted": 2})
    )
    respx.post("https://cloud.example.com/ingest/state").mock(
        return_value=httpx.Response(200, json={"inserted": 0})
    )
    respx.post("https://cloud.example.com/ingest/rollups").mock(
        return_value=httpx.Response(200, json={"inserted": 0})
    )

    settings = _settings()
    state = _fresh_state(settings.machine_id)

    async with (
        httpx.AsyncClient() as agent,
        CloudClient(settings.cloud_base_url, settings.shared_secret) as cloud,
    ):
        await run_once(settings, state, agent, cloud)

    assert events_route.called
    body = events_route.calls[0].request.content.decode()
    assert "program_change" in body
    assert "tool_change" in body
    assert "O01234" in body
    assert events_route.calls[0].request.headers["X-Edge-Secret"] == "smoke-secret"


@respx.mock
async def test_second_poll_after_state_change_posts_closed_interval():
    # First poll: ACTIVE
    # Second poll: STOPPED + alarm fixture
    route = respx.get("http://fake-agent.local:8082/current").mock(
        side_effect=[
            httpx.Response(200, content=(FIXTURES / "haas_current_active.xml").read_bytes()),
            httpx.Response(200, content=(FIXTURES / "haas_current_alarm.xml").read_bytes()),
        ]
    )
    state_route = respx.post("https://cloud.example.com/ingest/state").mock(
        return_value=httpx.Response(200, json={"inserted": 1})
    )
    respx.post("https://cloud.example.com/ingest/events").mock(
        return_value=httpx.Response(200, json={"inserted": 1})
    )
    respx.post("https://cloud.example.com/ingest/rollups").mock(
        return_value=httpx.Response(200, json={"inserted": 1})
    )

    settings = _settings()
    state = _fresh_state(settings.machine_id)

    async with (
        httpx.AsyncClient() as agent,
        CloudClient(settings.cloud_base_url, settings.shared_secret) as cloud,
    ):
        await run_once(settings, state, agent, cloud)  # opens ACTIVE interval
        await run_once(settings, state, agent, cloud)  # ACTIVE → STOPPED closes the interval

    assert route.call_count == 2
    assert state_route.called, "expected closed ACTIVE interval to POST to /ingest/state"
    body = state_route.calls[0].request.content.decode()
    assert '"state":"ACTIVE"' in body
    assert "O01234" in body


@respx.mock
async def test_agent_unreachable_does_not_crash():
    respx.get("http://fake-agent.local:8082/current").mock(
        return_value=httpx.Response(503)
    )
    events_route = respx.post("https://cloud.example.com/ingest/events").mock(
        return_value=httpx.Response(200, json={"inserted": 0})
    )
    respx.post("https://cloud.example.com/ingest/state").mock(
        return_value=httpx.Response(200, json={"inserted": 0})
    )
    respx.post("https://cloud.example.com/ingest/rollups").mock(
        return_value=httpx.Response(200, json={"inserted": 0})
    )

    settings = _settings()
    state = _fresh_state(settings.machine_id)

    async with (
        httpx.AsyncClient() as agent,
        CloudClient(settings.cloud_base_url, settings.shared_secret) as cloud,
    ):
        # Should fall back to synthetic OFFLINE snapshot and not raise.
        await run_once(settings, state, agent, cloud)

    # On first-ever poll with OFFLINE snapshot: program is None, tool is None, so no events.
    assert not events_route.called
