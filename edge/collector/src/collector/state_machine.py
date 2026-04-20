"""Execution-state machine: converts a stream of observations into closed intervals.

Pure logic only — no I/O. See `main.py` for the polling loop that drives this.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

ExecutionState = Literal["ACTIVE", "FEED_HOLD", "STOPPED", "INTERRUPTED", "OFFLINE"]

_STOPPED_ALIASES = {
    "READY",
    "STOPPED",
    "PROGRAM_STOPPED",
    "PROGRAM_COMPLETED",
    "OPTIONAL_STOP",
}
_PASSTHROUGH = {"ACTIVE", "FEED_HOLD", "INTERRUPTED"}


def normalize_execution(raw: str) -> ExecutionState:
    """Map any MTConnect Execution value (or unknown) to our 5-state alphabet."""
    v = (raw or "").strip().upper()
    if v in _PASSTHROUGH:
        return v  # type: ignore[return-value]
    if v in _STOPPED_ALIASES:
        return "STOPPED"
    return "OFFLINE"


@dataclass(frozen=True)
class StateInterval:
    machine_id: str
    state: ExecutionState
    started_at: datetime
    ended_at: datetime
    duration_seconds: int
    program: str | None
    tool_number: int | None


class StateMachine:
    """Tracks the currently-open execution-state interval for one machine.

    `observe(ts, raw_state, program, tool_number)` is called on every poll.
    Returns the list of closed intervals produced by that observation
    (zero or one, kept as a list for future extensibility).
    `close(ts)` force-closes the open interval — use on shutdown or to
    flush before a minute-rollup boundary if desired.
    """

    def __init__(self, machine_id: str) -> None:
        self.machine_id = machine_id
        self.current_state: ExecutionState | None = None
        self._started_at: datetime | None = None
        self._program: str | None = None
        self._tool_number: int | None = None

    def observe(
        self,
        ts: datetime,
        raw_state: str,
        program: str | None = None,
        tool_number: int | None = None,
    ) -> list[StateInterval]:
        normalized = normalize_execution(raw_state)

        if self.current_state is None:
            self._open(normalized, ts, program, tool_number)
            return []

        if normalized == self.current_state:
            return []

        closed = self._build_interval(ts)
        self._open(normalized, ts, program, tool_number)
        return [closed]

    def close(self, ts: datetime) -> StateInterval | None:
        if self.current_state is None:
            return None
        interval = self._build_interval(ts)
        self.current_state = None
        self._started_at = None
        self._program = None
        self._tool_number = None
        return interval

    def _open(
        self,
        state: ExecutionState,
        ts: datetime,
        program: str | None,
        tool_number: int | None,
    ) -> None:
        self.current_state = state
        self._started_at = ts
        self._program = program
        self._tool_number = tool_number

    def _build_interval(self, ts: datetime) -> StateInterval:
        assert self.current_state is not None
        assert self._started_at is not None
        duration = int((ts - self._started_at).total_seconds())
        return StateInterval(
            machine_id=self.machine_id,
            state=self.current_state,
            started_at=self._started_at,
            ended_at=ts,
            duration_seconds=duration,
            program=self._program,
            tool_number=self._tool_number,
        )
