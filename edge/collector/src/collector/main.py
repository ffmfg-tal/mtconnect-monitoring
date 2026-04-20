"""MVP polling loop.

Tails a single MTConnect agent's /current endpoint, drives the state machine
and minute-rollup accumulator, and pushes state intervals, events, and
rollups to the cloud worker. Runs forever until SIGINT.

Env vars (all required unless marked optional):
  MTCONNECT_AGENT_URL        e.g. http://192.168.10.23:8082  (Haas native agent)
  MTCONNECT_MACHINE_ID       e.g. haas-vf2-1  (must exist in cloud machines table)
  MTCONNECT_CLOUD_BASE_URL   e.g. https://mtconnect-collector.ffmfg.workers.dev
  EDGE_SHARED_SECRET         the X-Edge-Secret value
  MTCONNECT_POLL_SECONDS     optional, default 2
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from collector.cloud import (
    CloudClient,
    EventIn,
    RollupMinuteIn,
    StateIntervalIn,
)
from collector.mtconnect import CurrentSnapshot, parse_current
from collector.rollups import MinuteAccumulator, RollupMinute
from collector.state_machine import ExecutionState, StateInterval, StateMachine, normalize_execution

log = logging.getLogger("collector")


@dataclass(frozen=True)
class Settings:
    agent_url: str
    machine_id: str
    cloud_base_url: str
    shared_secret: str
    poll_seconds: float

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            agent_url=_require("MTCONNECT_AGENT_URL").rstrip("/"),
            machine_id=_require("MTCONNECT_MACHINE_ID"),
            cloud_base_url=_require("MTCONNECT_CLOUD_BASE_URL"),
            shared_secret=_require("EDGE_SHARED_SECRET"),
            poll_seconds=float(os.environ.get("MTCONNECT_POLL_SECONDS", "2")),
        )


def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"missing required env var: {name}")
    return v


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _interval_to_wire(interval: StateInterval) -> StateIntervalIn:
    return StateIntervalIn(
        machine_id=interval.machine_id,
        state=interval.state,
        started_at=_iso(interval.started_at),
        ended_at=_iso(interval.ended_at),
        duration_seconds=interval.duration_seconds,
        program=interval.program,
        tool_number=interval.tool_number,
    )


def _rollup_to_wire(r: RollupMinute) -> RollupMinuteIn:
    return RollupMinuteIn(
        machine_id=r.machine_id,
        minute_bucket=r.minute_bucket,
        active_seconds=r.active_seconds,
        feed_hold_seconds=r.feed_hold_seconds,
        stopped_seconds=r.stopped_seconds,
        interrupted_seconds=r.interrupted_seconds,
        offline_seconds=r.offline_seconds,
        part_count_delta=r.part_count_delta,
        program=r.program,
        tool_number=r.tool_number,
    )


async def _fetch_snapshot(
    agent: httpx.AsyncClient, agent_url: str, machine_id: str
) -> CurrentSnapshot | None:
    """Fetch /current; return None on transient network failure."""
    try:
        resp = await agent.get(f"{agent_url}/current", timeout=5.0)
        resp.raise_for_status()
        return parse_current(resp.content)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("agent fetch failed: %s", exc)
        return None


def _synthetic_offline(machine_id: str) -> CurrentSnapshot:
    return CurrentSnapshot(
        device_uuid=machine_id,
        creation_time=datetime.now(tz=timezone.utc),
        execution="UNAVAILABLE",
    )


@dataclass
class LoopState:
    """Mutable state carried across polls. Exposed so a test can drive a
    single iteration via `run_once`."""

    sm: StateMachine
    acc: MinuteAccumulator
    last_program: str | None = None
    last_tool: int | None = None
    last_part_count: int | None = None
    last_estop: str | None = None
    rollup_cursor: datetime | None = None
    prior_state: ExecutionState | None = None


async def run_once(
    settings: Settings,
    state: LoopState,
    agent_http: httpx.AsyncClient,
    cloud: CloudClient,
) -> None:
    """One poll: fetch /current, update state, push events/intervals/rollups."""
    snap = await _fetch_snapshot(agent_http, settings.agent_url, settings.machine_id)
    if snap is None:
        snap = _synthetic_offline(settings.machine_id)

    now = snap.creation_time

    closed = state.sm.observe(
        now, snap.execution, program=snap.program, tool_number=snap.tool_number
    )

    flushed_rollups: list[RollupMinute] = []
    if state.rollup_cursor is None or state.prior_state is None:
        state.rollup_cursor = now
        state.prior_state = normalize_execution(snap.execution)
    elif now > state.rollup_cursor:
        flushed_rollups.extend(
            state.acc.attribute(
                state.prior_state,
                state.rollup_cursor,
                now,
                program=state.last_program,
                tool_number=state.last_tool,
            )
        )
        state.rollup_cursor = now
        state.prior_state = normalize_execution(snap.execution)

    if closed:
        try:
            await cloud.post_state([_interval_to_wire(i) for i in closed])
            log.info(
                "pushed %d state interval(s): %s",
                len(closed),
                ", ".join(f"{i.state}({i.duration_seconds}s)" for i in closed),
            )
        except httpx.HTTPError as exc:
            log.error("post_state failed: %s", exc)

    if flushed_rollups:
        try:
            await cloud.post_rollups([_rollup_to_wire(r) for r in flushed_rollups])
            log.info("pushed %d rollup minute(s)", len(flushed_rollups))
        except httpx.HTTPError as exc:
            log.error("post_rollups failed: %s", exc)

    events: list[EventIn] = []

    if snap.program != state.last_program:
        events.append(
            EventIn(
                machine_id=settings.machine_id,
                ts=_iso(now),
                kind="program_change",
                severity="info",
                payload={"from": state.last_program, "to": snap.program},
            )
        )
        state.last_program = snap.program

    if snap.tool_number != state.last_tool and snap.tool_number is not None:
        events.append(
            EventIn(
                machine_id=settings.machine_id,
                ts=_iso(now),
                kind="tool_change",
                severity="info",
                payload={"from": state.last_tool, "to": snap.tool_number},
            )
        )
        state.last_tool = snap.tool_number

    if (
        snap.part_count is not None
        and state.last_part_count is not None
        and snap.part_count > state.last_part_count
    ):
        delta = snap.part_count - state.last_part_count
        for _ in range(delta):
            state.acc.note_part_completed(now)
        events.append(
            EventIn(
                machine_id=settings.machine_id,
                ts=_iso(now),
                kind="part_completed",
                severity="info",
                payload={"count": snap.part_count, "delta": delta},
            )
        )
    if snap.part_count is not None:
        state.last_part_count = snap.part_count

    if snap.emergency_stop == "TRIGGERED" and state.last_estop != "TRIGGERED":
        events.append(
            EventIn(
                machine_id=settings.machine_id,
                ts=_iso(now),
                kind="estop",
                severity="fault",
                payload={"state": "TRIGGERED"},
            )
        )
    state.last_estop = snap.emergency_stop

    for fault in snap.active_faults:
        events.append(
            EventIn(
                machine_id=settings.machine_id,
                ts=_iso(now),
                kind="alarm",
                severity="fault",
                payload={
                    "type": fault.type,
                    "message": fault.message,
                    "native_code": fault.native_code,
                },
            )
        )

    if events:
        try:
            await cloud.post_events(events)
            log.info(
                "pushed %d event(s): %s",
                len(events),
                ", ".join(e.kind for e in events),
            )
        except httpx.HTTPError as exc:
            log.error("post_events failed: %s", exc)


async def run_forever(settings: Settings) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log.info(
        "starting collector: machine=%s agent=%s cloud=%s poll=%.1fs",
        settings.machine_id,
        settings.agent_url,
        settings.cloud_base_url,
        settings.poll_seconds,
    )

    state = LoopState(
        sm=StateMachine(settings.machine_id),
        acc=MinuteAccumulator(settings.machine_id),
    )

    stop = asyncio.Event()

    def _handle_sig(*_: object) -> None:
        log.info("shutdown signal received")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_sig)
        except NotImplementedError:
            # Windows: add_signal_handler is limited; we rely on KeyboardInterrupt.
            signal.signal(sig, lambda *_: _handle_sig())

    async with (
        httpx.AsyncClient() as agent_http,
        CloudClient(settings.cloud_base_url, settings.shared_secret) as cloud,
    ):
        while not stop.is_set():
            await run_once(settings, state, agent_http, cloud)
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.poll_seconds)
            except asyncio.TimeoutError:
                pass

        # Shutdown: flush any pending rollup so we don't lose the final partial minute.
        if state.rollup_cursor is not None and state.prior_state is not None:
            final_now = datetime.now(tz=timezone.utc)
            if final_now > state.rollup_cursor:
                state.acc.attribute(
                    state.prior_state,
                    state.rollup_cursor,
                    final_now,
                    program=state.last_program,
                    tool_number=state.last_tool,
                )
        final_rollup = state.acc.close()
        if final_rollup is not None:
            try:
                await cloud.post_rollups([_rollup_to_wire(final_rollup)])
            except httpx.HTTPError as exc:
                log.error("shutdown flush failed: %s", exc)

    log.info("collector stopped")


def run() -> None:
    """Console-script entrypoint."""
    settings = Settings.from_env()
    try:
        asyncio.run(run_forever(settings))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    run()
