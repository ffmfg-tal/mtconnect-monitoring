from __future__ import annotations

from pathlib import Path

import aiosqlite

from forwarder.streams import Observation

SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
  device_uuid TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp_utc TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  sub_type TEXT,
  value_num REAL,
  value_str TEXT,
  condition_level TEXT,
  condition_native_code TEXT,
  condition_severity TEXT,
  condition_qualifier TEXT,
  forwarded_at TEXT,
  PRIMARY KEY (device_uuid, sequence)
);
CREATE INDEX IF NOT EXISTS idx_observations_forwarded ON observations(forwarded_at) WHERE forwarded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp_utc);

CREATE TABLE IF NOT EXISTS probe_cache (
  device_uuid TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  raw_xml TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_state (
  device_uuid TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_forward_at TEXT
);
"""


class ObservationBuffer:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        self._conn: aiosqlite.Connection | None = None

    async def init(self) -> None:
        self._conn = await aiosqlite.connect(self.path)
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    async def append(self, observations: list[Observation]) -> None:
        assert self._conn is not None
        await self._conn.executemany(
            """INSERT OR IGNORE INTO observations
               (device_uuid, sequence, timestamp_utc, data_item_id, category, type, sub_type,
                value_num, value_str, condition_level, condition_native_code,
                condition_severity, condition_qualifier)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            [
                (
                    o.device_uuid,
                    o.sequence,
                    o.timestamp,
                    o.data_item_id,
                    o.category,
                    o.type,
                    o.sub_type,
                    o.value_num,
                    o.value_str,
                    o.condition_level,
                    o.condition_native_code,
                    o.condition_severity,
                    o.condition_qualifier,
                )
                for o in observations
            ],
        )
        await self._conn.commit()

    async def unforwarded(self, limit: int = 500) -> list[Observation]:
        assert self._conn is not None
        async with self._conn.execute(
            """SELECT device_uuid, sequence, timestamp_utc, data_item_id, category, type, sub_type,
                      value_num, value_str, condition_level, condition_native_code,
                      condition_severity, condition_qualifier
               FROM observations
               WHERE forwarded_at IS NULL
               ORDER BY device_uuid, sequence
               LIMIT ?""",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
        return [
            Observation(
                device_uuid=r[0],
                sequence=r[1],
                timestamp=r[2],
                data_item_id=r[3],
                category=r[4],
                type=r[5],
                sub_type=r[6],
                value_num=r[7],
                value_str=r[8],
                condition_level=r[9],
                condition_native_code=r[10],
                condition_severity=r[11],
                condition_qualifier=r[12],
            )
            for r in rows
        ]

    async def mark_forwarded(self, device_uuid: str, high_water_sequence: int) -> None:
        assert self._conn is not None
        from datetime import UTC, datetime

        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        await self._conn.execute(
            "UPDATE observations SET forwarded_at = ? WHERE device_uuid = ? AND sequence <= ? AND forwarded_at IS NULL",
            (now, device_uuid, high_water_sequence),
        )
        await self._conn.commit()

    async def set_agent_state(
        self, device_uuid: str, *, instance_id: str, last_sequence: int
    ) -> None:
        assert self._conn is not None
        from datetime import UTC, datetime

        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        await self._conn.execute(
            """INSERT INTO agent_state (device_uuid, instance_id, last_sequence, last_forward_at)
               VALUES (?,?,?,?)
               ON CONFLICT(device_uuid) DO UPDATE SET
                 instance_id = excluded.instance_id,
                 last_sequence = excluded.last_sequence,
                 last_forward_at = excluded.last_forward_at""",
            (device_uuid, instance_id, last_sequence, now),
        )
        await self._conn.commit()

    async def get_agent_state(self, device_uuid: str) -> tuple[str, int] | None:
        assert self._conn is not None
        async with self._conn.execute(
            "SELECT instance_id, last_sequence FROM agent_state WHERE device_uuid = ?",
            (device_uuid,),
        ) as cur:
            row = await cur.fetchone()
        return (row[0], row[1]) if row else None
