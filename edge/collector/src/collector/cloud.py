"""Cloud worker client.

Thin httpx wrapper that batch-POSTs events, state intervals, and minute
rollups to the mtconnect-collector Cloudflare Worker. Authenticates with the
X-Edge-Secret shared-secret header.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import httpx


@dataclass
class EventIn:
    machine_id: str
    ts: str
    kind: str
    severity: str
    payload: dict[str, Any] | None = None


@dataclass
class StateIntervalIn:
    machine_id: str
    state: str
    started_at: str
    ended_at: str
    duration_seconds: int
    program: str | None = None
    tool_number: int | None = None


@dataclass
class RollupMinuteIn:
    machine_id: str
    minute_bucket: str
    active_seconds: int
    feed_hold_seconds: int
    stopped_seconds: int
    interrupted_seconds: int
    offline_seconds: int
    part_count_delta: int
    spindle_rpm_avg: float | None = None
    spindle_load_avg: float | None = None
    spindle_load_max: float | None = None
    feedrate_avg: float | None = None
    feed_override_avg: float | None = None
    program: str | None = None
    tool_number: int | None = None


class CloudClient:
    def __init__(
        self,
        base_url: str,
        shared_secret: str,
        timeout_seconds: float = 10.0,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._secret = shared_secret
        self._http = httpx.AsyncClient(
            timeout=timeout_seconds,
            headers={"X-Edge-Secret": shared_secret, "Content-Type": "application/json"},
        )

    async def __aenter__(self) -> "CloudClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def post_events(self, events: list[EventIn]) -> None:
        if not events:
            return
        await self._post("/ingest/events", [asdict(e) for e in events])

    async def post_state(self, intervals: list[StateIntervalIn]) -> None:
        if not intervals:
            return
        await self._post("/ingest/state", [asdict(i) for i in intervals])

    async def post_rollups(self, rollups: list[RollupMinuteIn]) -> None:
        if not rollups:
            return
        await self._post("/ingest/rollups", [asdict(r) for r in rollups])

    async def _post(self, path: str, body: list[dict[str, Any]]) -> None:
        resp = await self._http.post(self._base + path, json=body)
        resp.raise_for_status()
