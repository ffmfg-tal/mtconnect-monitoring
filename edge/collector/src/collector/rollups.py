"""Minute-rollup accumulator: time-slices state attributions into minute buckets.

Pure logic only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from collector.state_machine import ExecutionState


def minute_bucket_iso(ts: datetime) -> str:
    """Floor to minute, serialize as ISO with trailing Z."""
    floored = ts.replace(second=0, microsecond=0)
    floored_utc = floored.astimezone(timezone.utc) if floored.tzinfo else floored
    return floored_utc.strftime("%Y-%m-%dT%H:%M:00Z")


@dataclass
class RollupMinute:
    machine_id: str
    minute_bucket: str
    active_seconds: int = 0
    feed_hold_seconds: int = 0
    stopped_seconds: int = 0
    interrupted_seconds: int = 0
    offline_seconds: int = 0
    part_count_delta: int = 0
    program: str | None = None
    tool_number: int | None = None


_FIELD_FOR_STATE: dict[ExecutionState, str] = {
    "ACTIVE": "active_seconds",
    "FEED_HOLD": "feed_hold_seconds",
    "STOPPED": "stopped_seconds",
    "INTERRUPTED": "interrupted_seconds",
    "OFFLINE": "offline_seconds",
}


class MinuteAccumulator:
    """Accumulates per-state seconds into 1-minute buckets.

    Call `attribute(state, start, end, program=..., tool_number=...)` for each
    closed time span. Returns any minute buckets that completed as a result.
    `note_part_completed(at)` bumps the current bucket's part_count_delta.
    `close()` emits and clears the currently-open bucket (for shutdown).
    """

    def __init__(self, machine_id: str) -> None:
        self.machine_id = machine_id
        self._pending: RollupMinute | None = None

    def attribute(
        self,
        state: ExecutionState,
        start: datetime,
        end: datetime,
        program: str | None = None,
        tool_number: int | None = None,
    ) -> list[RollupMinute]:
        if end <= start:
            return []

        flushed: list[RollupMinute] = []
        cursor = start
        while cursor < end:
            bucket_start = cursor.replace(second=0, microsecond=0)
            next_boundary = bucket_start + timedelta(minutes=1)
            chunk_end = min(end, next_boundary)
            seconds = int((chunk_end - cursor).total_seconds())

            bucket_key = minute_bucket_iso(cursor)
            if self._pending is None:
                self._pending = RollupMinute(
                    machine_id=self.machine_id, minute_bucket=bucket_key
                )
            elif self._pending.minute_bucket != bucket_key:
                flushed.append(self._pending)
                self._pending = RollupMinute(
                    machine_id=self.machine_id, minute_bucket=bucket_key
                )

            field_name = _FIELD_FOR_STATE[state]
            setattr(
                self._pending,
                field_name,
                getattr(self._pending, field_name) + seconds,
            )
            if program is not None:
                self._pending.program = program
            if tool_number is not None:
                self._pending.tool_number = tool_number

            # If we landed exactly on the boundary, flush now.
            if chunk_end == next_boundary:
                flushed.append(self._pending)
                self._pending = None

            cursor = chunk_end

        return flushed

    def note_part_completed(self, at: datetime) -> None:
        bucket_key = minute_bucket_iso(at)
        if self._pending is None:
            self._pending = RollupMinute(
                machine_id=self.machine_id, minute_bucket=bucket_key
            )
        elif self._pending.minute_bucket != bucket_key:
            # Belongs to a future bucket; leave current bucket alone and start a new one.
            # (Caller should call attribute() first to close out the current bucket.)
            return
        self._pending.part_count_delta += 1

    def close(self) -> RollupMinute | None:
        snapshot = self._pending
        self._pending = None
        return snapshot
