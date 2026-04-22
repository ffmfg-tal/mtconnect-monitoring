# Phase 2 — Edge Forwarder + cppagent Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the edge forwarder (Python 3.12 async), the cppagent + replay-simulator harness, the podman-compose stack, and the Ansible NUC baseline playbook. End-to-end: cppagent replays Mazak SHDR trace → forwarder long-polls `/sample` → forwarder POSTs to cloud Worker. No real hardware yet.

**Architecture:** Forwarder is three pure-ish modules (probe parser, streams parser, aiosqlite buffer) orchestrated by a long-poll loop. Cppagent runs in a container reading `Devices.xml` and a socket-fed SHDR stream from `simulator.rb`. Everything runs under podman-compose on a Linux VM; the Ansible playbook provisions the NUC baseline (FDE, SSH keys, monitoring VLAN, rootless podman, auditd, NTP).

**Tech Stack:** Python 3.12, `httpx`, `aiosqlite`, `lxml`, `pytest`, `pytest-asyncio`, `ruff`, `pyright`. Podman + podman-compose. Ansible. Ruby 3 + cppagent's `simulator/simulator.rb` script.

**Spec reference:** `docs/superpowers/specs/2026-04-22-mtconnect-v2-redesign.md` § "Edge components (NUC)" and § "NUC baseline (Ansible)"
**Precondition:** Phase 1 complete — local cloud Worker accepts `/ingest/probe` and `/ingest/observations`.

---

## File structure after this phase

```
edge/
├── forwarder/
│   ├── pyproject.toml
│   ├── Dockerfile
│   ├── src/
│   │   └── forwarder/
│   │       ├── __init__.py
│   │       ├── probe.py              # XML parse for /probe
│   │       ├── streams.py            # XML parse for /sample chunks
│   │       ├── buffer.py             # aiosqlite buffer-of-record
│   │       ├── cloud_client.py       # httpx async client to CF Worker
│   │       ├── agent_client.py       # httpx long-poll client to cppagent
│   │       ├── main.py               # orchestration / CLI entry
│   │       └── config.py             # env-var config
│   └── tests/
│       ├── __init__.py
│       ├── fixtures/
│       │   ├── mazak_probe.xml
│       │   ├── mazak_sample_chunk1.xml
│       │   └── mazak_sample_chunk2.xml
│       ├── test_probe.py
│       ├── test_streams.py
│       ├── test_buffer.py
│       ├── test_cloud_client.py
│       ├── test_agent_client.py
│       └── test_main_smoke.py
├── cppagent/
│   ├── agent.cfg
│   ├── Devices.xml
│   └── devices/
│       ├── simulator-mazak.xml      # template per controller
│       └── simulator-okuma.xml
├── simulator/
│   ├── simulator.rb                 # vendored from mtconnect/cppagent
│   ├── mazak.txt                    # recorded SHDR trace (fetched from repo)
│   └── okuma.txt
├── compose/
│   ├── compose.yml
│   └── .env.example
└── ansible/
    ├── inventory.example.ini
    ├── playbook.yml
    ├── roles/
    │   ├── baseline/
    │   │   └── tasks/main.yml
    │   ├── podman/
    │   │   └── tasks/main.yml
    │   ├── monitoring_vlan/
    │   │   └── tasks/main.yml
    │   └── mtconnect_stack/
    │       └── tasks/main.yml
    └── README.md
```

---

## Task 1: Forwarder project scaffold

**Files:**
- Create: `edge/forwarder/pyproject.toml`
- Create: `edge/forwarder/src/forwarder/__init__.py`
- Create: `edge/forwarder/tests/__init__.py`

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[project]
name = "mtconnect-forwarder"
version = "0.1.0"
description = "MTConnect edge forwarder: cppagent long-poll -> SQLite buffer -> cloud Worker"
requires-python = ">=3.12"
dependencies = [
  "httpx>=0.27",
  "aiosqlite>=0.20",
  "lxml>=5.2",
]

[project.optional-dependencies]
dev = [
  "pytest>=8.3",
  "pytest-asyncio>=0.24",
  "pytest-httpx>=0.32",
  "ruff>=0.7",
  "pyright>=1.1.380",
]

[project.scripts]
forwarder = "forwarder.main:cli"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "ASYNC"]
```

- [ ] **Step 2: Empty package init files**

```bash
mkdir -p edge/forwarder/src/forwarder edge/forwarder/tests/fixtures
touch edge/forwarder/src/forwarder/__init__.py
touch edge/forwarder/tests/__init__.py
```

- [ ] **Step 3: Install locally to verify build**

```bash
cd edge/forwarder && python -m pip install -e ".[dev]"
```

Expected: install succeeds, `pytest --version` works.

- [ ] **Step 4: Commit**

```bash
git add edge/forwarder/pyproject.toml edge/forwarder/src/forwarder/__init__.py edge/forwarder/tests/__init__.py
git commit -m "chore(edge): scaffold forwarder Python package"
```

---

## Task 2: Capture Mazak fixture from cppagent repo

**Files:**
- Create: `edge/forwarder/tests/fixtures/mazak_probe.xml`
- Create: `edge/forwarder/tests/fixtures/mazak_sample_chunk1.xml`

- [ ] **Step 1: Fetch the reference Devices.xml and example streams**

We want real-shape fixtures. Use `demo.mtconnect.org` (runs Mazak simulator) for this — easier than spinning up cppagent just for fixture capture.

```bash
curl -s https://demo.mtconnect.org/probe > edge/forwarder/tests/fixtures/mazak_probe.xml
curl -s "https://demo.mtconnect.org/sample?count=500" > edge/forwarder/tests/fixtures/mazak_sample_chunk1.xml
# Fetch a second chunk starting from the next sequence in chunk1's header
NEXT=$(grep -oE 'nextSequence="[0-9]+"' edge/forwarder/tests/fixtures/mazak_sample_chunk1.xml | head -1 | grep -oE '[0-9]+')
curl -s "https://demo.mtconnect.org/sample?from=$NEXT&count=500" > edge/forwarder/tests/fixtures/mazak_sample_chunk2.xml
```

- [ ] **Step 2: Commit**

```bash
git add edge/forwarder/tests/fixtures/
git commit -m "test(edge): capture MTConnect probe + sample fixtures from demo.mtconnect.org"
```

---

## Task 3: Probe parser (Python)

**Files:**
- Create: `edge/forwarder/tests/test_probe.py`
- Create: `edge/forwarder/src/forwarder/probe.py`

- [ ] **Step 1: Write failing test**

```python
# edge/forwarder/tests/test_probe.py
from pathlib import Path

from forwarder.probe import parse_probe

FIXTURE = Path(__file__).parent / "fixtures" / "mazak_probe.xml"


def test_extracts_header():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    assert r.instance_id
    assert r.schema_version


def test_extracts_at_least_one_device():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    assert len(r.devices) >= 1
    d = r.devices[0]
    assert d.uuid
    assert d.name


def test_extracts_data_items_with_category_and_type():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    all_items = [di for dev in r.devices for di in dev.data_items]
    assert len(all_items) > 0
    exec_items = [di for di in all_items if di.type == "EXECUTION"]
    assert len(exec_items) >= 1
    assert exec_items[0].category == "EVENT"


def test_every_data_item_has_component_path():
    r = parse_probe(FIXTURE.read_text(encoding="utf-8"))
    all_items = [di for dev in r.devices for di in dev.data_items]
    assert all(di.component_path for di in all_items)
```

- [ ] **Step 2: Run — expect failure**

Run: `cd edge/forwarder && pytest tests/test_probe.py -v`
Expected: ImportError.

- [ ] **Step 3: Implement `edge/forwarder/src/forwarder/probe.py`**

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from lxml import etree

NS = "{urn:mtconnect.org:MTConnectDevices:2.7}"


@dataclass(frozen=True)
class DataItem:
    id: str
    name: str | None
    category: Literal["SAMPLE", "EVENT", "CONDITION"]
    type: str
    sub_type: str | None
    units: str | None
    native_units: str | None
    component_path: str


@dataclass(frozen=True)
class Device:
    uuid: str
    name: str
    model: str | None
    data_items: list[DataItem] = field(default_factory=list)


@dataclass(frozen=True)
class ProbeResult:
    instance_id: str
    schema_version: str
    creation_time: str
    devices: list[Device]


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _collect_data_items(node: etree._Element, path: str, out: list[DataItem]) -> None:
    for child in node:
        local = _local(child.tag)
        if local == "DataItems":
            for di in child:
                if _local(di.tag) != "DataItem":
                    continue
                cat = di.get("category")
                if cat not in {"SAMPLE", "EVENT", "CONDITION"}:
                    continue
                out.append(
                    DataItem(
                        id=di.get("id", ""),
                        name=di.get("name"),
                        category=cat,  # type: ignore[arg-type]
                        type=di.get("type", ""),
                        sub_type=di.get("subType"),
                        units=di.get("units"),
                        native_units=di.get("nativeUnits"),
                        component_path=path,
                    )
                )
        elif local in {"Components"}:
            for comp in child:
                comp_name = comp.get("name") or _local(comp.tag)
                _collect_data_items(comp, f"{path}/{comp_name}", out)


def parse_probe(xml: str) -> ProbeResult:
    root = etree.fromstring(xml.encode("utf-8"))
    header = next(child for child in root if _local(child.tag) == "Header")
    devices_node = next(child for child in root if _local(child.tag) == "Devices")

    devices: list[Device] = []
    for d in devices_node:
        if _local(d.tag) != "Device":
            continue
        data_items: list[DataItem] = []
        _collect_data_items(d, d.get("name", ""), data_items)
        devices.append(
            Device(
                uuid=d.get("uuid", ""),
                name=d.get("name", ""),
                model=d.get("model"),
                data_items=data_items,
            )
        )

    return ProbeResult(
        instance_id=header.get("instanceId", ""),
        schema_version=header.get("schemaVersion", header.get("version", "")),
        creation_time=header.get("creationTime", ""),
        devices=devices,
    )
```

- [ ] **Step 4: Run — expect pass**

Run: `cd edge/forwarder && pytest tests/test_probe.py -v`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add edge/forwarder/src/forwarder/probe.py edge/forwarder/tests/test_probe.py
git commit -m "feat(edge): probe XML parser (lxml, 2.7 schema)"
```

---

## Task 4: Streams parser (Python)

**Files:**
- Create: `edge/forwarder/tests/test_streams.py`
- Create: `edge/forwarder/src/forwarder/streams.py`

- [ ] **Step 1: Write failing test**

```python
# edge/forwarder/tests/test_streams.py
from pathlib import Path

from forwarder.streams import parse_streams

FIXTURE = Path(__file__).parent / "fixtures" / "mazak_sample_chunk1.xml"


def test_extracts_header_with_sequences():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    assert r.instance_id
    assert r.first_sequence >= 0
    assert r.next_sequence > r.first_sequence


def test_extracts_observations_with_required_fields():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    assert len(r.observations) > 0
    o = r.observations[0]
    assert o.device_uuid
    assert isinstance(o.sequence, int)
    assert o.timestamp
    assert o.data_item_id
    assert o.category in {"SAMPLE", "EVENT", "CONDITION"}


def test_parses_condition_level_when_category_is_condition():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    conds = [o for o in r.observations if o.category == "CONDITION"]
    for c in conds:
        assert c.condition_level in {"NORMAL", "WARNING", "FAULT", "UNAVAILABLE"}


def test_parses_value_num_for_numeric_samples():
    r = parse_streams(FIXTURE.read_text(encoding="utf-8"))
    samples = [
        o for o in r.observations if o.category == "SAMPLE" and o.value_str and o.value_str != "UNAVAILABLE"
    ]
    numeric = [s for s in samples if s.value_num is not None]
    assert len(numeric) > 0
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `edge/forwarder/src/forwarder/streams.py`**

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from lxml import etree

CATEGORY_PARENTS: dict[str, Literal["SAMPLE", "EVENT", "CONDITION"]] = {
    "Samples": "SAMPLE",
    "Events": "EVENT",
    "Condition": "CONDITION",
}
CONDITION_LEVELS = {"Normal", "Warning", "Fault", "Unavailable"}


@dataclass(frozen=True)
class Observation:
    device_uuid: str
    sequence: int
    timestamp: str
    data_item_id: str
    category: Literal["SAMPLE", "EVENT", "CONDITION"]
    type: str
    sub_type: str | None
    value_num: float | None
    value_str: str | None
    condition_level: Literal["NORMAL", "WARNING", "FAULT", "UNAVAILABLE"] | None
    condition_native_code: str | None
    condition_severity: str | None
    condition_qualifier: str | None


@dataclass(frozen=True)
class StreamsResult:
    instance_id: str
    first_sequence: int
    last_sequence: int
    next_sequence: int
    schema_version: str
    creation_time: str
    observations: list[Observation]


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _parse_float_or_none(s: str | None) -> float | None:
    if s is None or s == "UNAVAILABLE":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_streams(xml: str) -> StreamsResult:
    root = etree.fromstring(xml.encode("utf-8"))
    header = next(c for c in root if _local(c.tag) == "Header")
    streams = next((c for c in root if _local(c.tag) == "Streams"), None)

    observations: list[Observation] = []
    if streams is not None:
        for dev_stream in streams:
            if _local(dev_stream.tag) != "DeviceStream":
                continue
            device_uuid = dev_stream.get("uuid", "")
            for comp_stream in dev_stream:
                if _local(comp_stream.tag) != "ComponentStream":
                    continue
                for category_node in comp_stream:
                    tag = _local(category_node.tag)
                    if tag not in CATEGORY_PARENTS:
                        continue
                    category = CATEGORY_PARENTS[tag]
                    for item in category_node:
                        itag = _local(item.tag)
                        if category == "CONDITION":
                            if itag not in CONDITION_LEVELS:
                                continue
                            observations.append(
                                Observation(
                                    device_uuid=device_uuid,
                                    sequence=int(item.get("sequence", "0")),
                                    timestamp=item.get("timestamp", ""),
                                    data_item_id=item.get("dataItemId", ""),
                                    category="CONDITION",
                                    type=item.get("type", ""),
                                    sub_type=item.get("subType"),
                                    value_num=None,
                                    value_str=item.text,
                                    condition_level=itag.upper(),  # type: ignore[arg-type]
                                    condition_native_code=item.get("nativeCode"),
                                    condition_severity=item.get("nativeSeverity"),
                                    condition_qualifier=item.get("qualifier"),
                                )
                            )
                        else:
                            text = item.text
                            observations.append(
                                Observation(
                                    device_uuid=device_uuid,
                                    sequence=int(item.get("sequence", "0")),
                                    timestamp=item.get("timestamp", ""),
                                    data_item_id=item.get("dataItemId", ""),
                                    category=category,
                                    type=itag,
                                    sub_type=item.get("subType"),
                                    value_num=_parse_float_or_none(text),
                                    value_str=text,
                                    condition_level=None,
                                    condition_native_code=None,
                                    condition_severity=None,
                                    condition_qualifier=None,
                                )
                            )

    return StreamsResult(
        instance_id=header.get("instanceId", ""),
        first_sequence=int(header.get("firstSequence", "0")),
        last_sequence=int(header.get("lastSequence", "0")),
        next_sequence=int(header.get("nextSequence", "0")),
        schema_version=header.get("schemaVersion", header.get("version", "")),
        creation_time=header.get("creationTime", ""),
        observations=observations,
    )
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add edge/forwarder/src/forwarder/streams.py edge/forwarder/tests/test_streams.py
git commit -m "feat(edge): streams XML parser — SAMPLE/EVENT/CONDITION"
```

---

## Task 5: aiosqlite buffer-of-record

**Files:**
- Create: `edge/forwarder/tests/test_buffer.py`
- Create: `edge/forwarder/src/forwarder/buffer.py`

- [ ] **Step 1: Write failing tests**

```python
# edge/forwarder/tests/test_buffer.py
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
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `edge/forwarder/src/forwarder/buffer.py`**

```python
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
```

- [ ] **Step 4: Run — expect pass**

Run: `cd edge/forwarder && pytest tests/test_buffer.py -v`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add edge/forwarder/src/forwarder/buffer.py edge/forwarder/tests/test_buffer.py
git commit -m "feat(edge): aiosqlite buffer-of-record with forward tracking"
```

---

## Task 6: Cloud client (httpx async)

**Files:**
- Create: `edge/forwarder/tests/test_cloud_client.py`
- Create: `edge/forwarder/src/forwarder/cloud_client.py`

- [ ] **Step 1: Write test**

```python
# edge/forwarder/tests/test_cloud_client.py
import pytest
from pytest_httpx import HTTPXMock

from forwarder.cloud_client import CloudClient
from forwarder.probe import Device, DataItem, ProbeResult
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
```

- [ ] **Step 2: Implement `edge/forwarder/src/forwarder/cloud_client.py`**

```python
from __future__ import annotations

from typing import Any

import httpx

from forwarder.probe import ProbeResult
from forwarder.streams import Observation


class CloudClient:
    def __init__(self, base_url: str, secret: str, *, timeout: float = 10.0) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"X-Edge-Secret": secret, "content-type": "application/json"},
            timeout=timeout,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def post_probe(
        self, probe: ProbeResult, probe_xml: str, device_uuid: str
    ) -> dict[str, Any]:
        device = next(d for d in probe.devices if d.uuid == device_uuid)
        body = {
            "device_uuid": device.uuid,
            "name": device.name,
            "model": device.model,
            "controller_type": None,
            "controller_vendor": None,
            "mtconnect_version": probe.schema_version,
            "instance_id": probe.instance_id,
            "probe_xml": probe_xml,
            "data_items": [
                {
                    "id": di.id,
                    "category": di.category,
                    "type": di.type,
                    "subType": di.sub_type,
                    "units": di.units,
                    "nativeUnits": di.native_units,
                    "componentPath": di.component_path,
                }
                for di in device.data_items
            ],
        }
        res = await self._client.post("/ingest/probe", json=body)
        res.raise_for_status()
        return res.json()

    async def post_observations(
        self,
        device_uuid: str,
        instance_id: str,
        observations: list[Observation],
        *,
        gap: tuple[int, int] | None = None,
    ) -> dict[str, Any]:
        batch = [
            {
                "sequence": o.sequence,
                "timestamp": o.timestamp,
                "data_item_id": o.data_item_id,
                "category": o.category,
                "type": o.type,
                "sub_type": o.sub_type,
                "value_num": o.value_num,
                "value_str": o.value_str,
                "condition_level": o.condition_level,
                "condition_native_code": o.condition_native_code,
                "condition_severity": o.condition_severity,
                "condition_qualifier": o.condition_qualifier,
            }
            for o in observations
        ]
        body: dict[str, Any] = {
            "device_uuid": device_uuid,
            "instance_id": instance_id,
            "batch": batch,
        }
        if gap is not None:
            body["gap"] = {"start_seq": gap[0], "end_seq": gap[1]}
        res = await self._client.post("/ingest/observations", json=body)
        res.raise_for_status()
        return res.json()
```

- [ ] **Step 3: Run — expect pass**

- [ ] **Step 4: Commit**

```bash
git add edge/forwarder/src/forwarder/cloud_client.py edge/forwarder/tests/test_cloud_client.py
git commit -m "feat(edge): async cloud client for /ingest/probe and /ingest/observations"
```

---

## Task 7: Agent client (long-poll /sample)

**Files:**
- Create: `edge/forwarder/tests/test_agent_client.py`
- Create: `edge/forwarder/src/forwarder/agent_client.py`

- [ ] **Step 1: Write test**

```python
# edge/forwarder/tests/test_agent_client.py
from pathlib import Path

from pytest_httpx import HTTPXMock

from forwarder.agent_client import AgentClient

FIX = Path(__file__).parent / "fixtures"


async def test_fetch_probe(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://agent.test:5000/probe",
        text=(FIX / "mazak_probe.xml").read_text(encoding="utf-8"),
    )
    client = AgentClient("http://agent.test:5000")
    xml = await client.fetch_probe()
    assert xml.startswith("<?xml")
    await client.close()


async def test_fetch_sample_at_cursor(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://agent.test:5000/sample?from=100&count=1000",
        text=(FIX / "mazak_sample_chunk1.xml").read_text(encoding="utf-8"),
    )
    client = AgentClient("http://agent.test:5000")
    xml = await client.fetch_sample(from_sequence=100, count=1000)
    assert "MTConnectStreams" in xml
    await client.close()


async def test_fetch_current(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="http://agent.test:5000/current",
        text=(FIX / "mazak_sample_chunk1.xml").read_text(encoding="utf-8"),
    )
    client = AgentClient("http://agent.test:5000")
    xml = await client.fetch_current()
    assert "MTConnectStreams" in xml
    await client.close()
```

- [ ] **Step 2: Implement**

```python
# edge/forwarder/src/forwarder/agent_client.py
from __future__ import annotations

import httpx


class AgentClient:
    def __init__(self, base_url: str, *, timeout: float = 30.0) -> None:
        self._client = httpx.AsyncClient(base_url=base_url, timeout=timeout)

    async def close(self) -> None:
        await self._client.aclose()

    async def fetch_probe(self) -> str:
        r = await self._client.get("/probe")
        r.raise_for_status()
        return r.text

    async def fetch_current(self) -> str:
        r = await self._client.get("/current")
        r.raise_for_status()
        return r.text

    async def fetch_sample(
        self,
        *,
        from_sequence: int,
        count: int = 1000,
        interval_ms: int | None = None,
        heartbeat_ms: int | None = None,
    ) -> str:
        params: dict[str, str | int] = {"from": from_sequence, "count": count}
        if interval_ms is not None:
            params["interval"] = interval_ms
        if heartbeat_ms is not None:
            params["heartbeat"] = heartbeat_ms
        r = await self._client.get("/sample", params=params)
        r.raise_for_status()
        return r.text
```

Note: true long-poll (chunked multipart) requires streaming response parsing. For Phase 2 we use discrete `/sample?from=&count=` polling in a tight loop — functionally equivalent when the cursor is threaded correctly and simpler to test. True chunked long-poll can be retrofitted as a performance optimization once the end-to-end pipeline is proven.

- [ ] **Step 3: Run — expect pass, commit**

```bash
git add edge/forwarder/src/forwarder/agent_client.py edge/forwarder/tests/test_agent_client.py
git commit -m "feat(edge): agent client for /probe, /current, /sample (polling form)"
```

---

## Task 8: Orchestrator / CLI entry

**Files:**
- Create: `edge/forwarder/src/forwarder/config.py`
- Create: `edge/forwarder/src/forwarder/main.py`
- Create: `edge/forwarder/tests/test_main_smoke.py`

- [ ] **Step 1: Write config**

```python
# edge/forwarder/src/forwarder/config.py
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    agent_url: str
    cloud_base_url: str
    cloud_secret: str
    buffer_path: str
    poll_interval_s: float
    forward_interval_s: float
    forward_batch_size: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            agent_url=os.environ.get("MTC_AGENT_URL", "http://localhost:5000"),
            cloud_base_url=os.environ.get("MTC_CLOUD_URL", "http://localhost:8787"),
            cloud_secret=os.environ.get("MTC_EDGE_SECRET", "test-secret"),
            buffer_path=os.environ.get("MTC_BUFFER_PATH", "/var/lib/mtconnect/forwarder.sqlite"),
            poll_interval_s=float(os.environ.get("MTC_POLL_INTERVAL_S", "1.0")),
            forward_interval_s=float(os.environ.get("MTC_FORWARD_INTERVAL_S", "1.0")),
            forward_batch_size=int(os.environ.get("MTC_FORWARD_BATCH", "500")),
        )
```

- [ ] **Step 2: Write main orchestrator**

```python
# edge/forwarder/src/forwarder/main.py
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from forwarder.agent_client import AgentClient
from forwarder.buffer import ObservationBuffer
from forwarder.cloud_client import CloudClient
from forwarder.config import Config
from forwarder.probe import parse_probe
from forwarder.streams import parse_streams

log = logging.getLogger("forwarder")


async def run(config: Config) -> None:
    Path(config.buffer_path).parent.mkdir(parents=True, exist_ok=True)
    buffer = ObservationBuffer(config.buffer_path)
    await buffer.init()
    agent = AgentClient(config.agent_url)
    cloud = CloudClient(config.cloud_base_url, config.cloud_secret)

    try:
        # 1. fetch probe, post to cloud, seed cursors
        probe_xml = await agent.fetch_probe()
        probe = parse_probe(probe_xml)
        for device in probe.devices:
            await cloud.post_probe(probe, probe_xml, device.uuid)

        # seed cursors from /current if we have no persisted state
        current_xml = await agent.fetch_current()
        current = parse_streams(current_xml)
        for device in probe.devices:
            state = await buffer.get_agent_state(device.uuid)
            if state is None or state[0] != current.instance_id:
                await buffer.set_agent_state(
                    device.uuid,
                    instance_id=current.instance_id,
                    last_sequence=current.next_sequence,
                )

        # 2. concurrent tasks: poll loop and forward loop
        await asyncio.gather(
            poll_loop(agent, buffer, probe, config),
            forward_loop(buffer, cloud, config),
        )
    finally:
        await buffer.close()
        await agent.close()
        await cloud.close()


async def poll_loop(
    agent: AgentClient,
    buffer: ObservationBuffer,
    probe: "object",  # noqa: ARG001
    config: Config,
) -> None:
    from forwarder.probe import ProbeResult

    p: ProbeResult = probe  # type: ignore[assignment]
    while True:
        for device in p.devices:
            state = await buffer.get_agent_state(device.uuid)
            if state is None:
                continue
            instance_id, from_seq = state
            try:
                xml = await agent.fetch_sample(from_sequence=from_seq, count=1000)
            except Exception:
                log.exception("fetch_sample failed")
                continue
            parsed = parse_streams(xml)

            # instance_id change: rebaseline
            if parsed.instance_id != instance_id:
                log.warning(
                    "agent restart detected: %s -> %s; rebaselining",
                    instance_id,
                    parsed.instance_id,
                )
                await buffer.set_agent_state(
                    device.uuid,
                    instance_id=parsed.instance_id,
                    last_sequence=parsed.next_sequence,
                )
                continue

            # gap detection: first_sequence > from_seq means we lost observations
            if parsed.first_sequence > from_seq:
                log.error(
                    "gap detected for %s: from=%d first=%d",
                    device.uuid,
                    from_seq,
                    parsed.first_sequence,
                )
                # TODO: record gap event to forwarder buffer, surface on next forward batch

            for_device = [o for o in parsed.observations if o.device_uuid == device.uuid]
            if for_device:
                await buffer.append(for_device)
            await buffer.set_agent_state(
                device.uuid,
                instance_id=parsed.instance_id,
                last_sequence=parsed.next_sequence,
            )
        await asyncio.sleep(config.poll_interval_s)


async def forward_loop(
    buffer: ObservationBuffer,
    cloud: CloudClient,
    config: Config,
) -> None:
    backoff = 1.0
    while True:
        pending = await buffer.unforwarded(limit=config.forward_batch_size)
        if not pending:
            await asyncio.sleep(config.forward_interval_s)
            continue

        # group by device + instance (instance is drawn from agent_state)
        by_device: dict[str, list] = {}
        for o in pending:
            by_device.setdefault(o.device_uuid, []).append(o)

        ok = True
        for device_uuid, obs_list in by_device.items():
            state = await buffer.get_agent_state(device_uuid)
            if state is None:
                continue
            instance_id, _ = state
            try:
                result = await cloud.post_observations(device_uuid, instance_id, obs_list)
                high = int(result.get("high_water_sequence", 0))
                if high > 0:
                    await buffer.mark_forwarded(device_uuid, high)
            except Exception:
                log.exception("forward failed for %s", device_uuid)
                ok = False

        if ok:
            backoff = 1.0
            await asyncio.sleep(config.forward_interval_s)
        else:
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)


def cli() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    cfg = Config.from_env()
    asyncio.run(run(cfg))
```

- [ ] **Step 3: Write smoke test — uses httpx_mock to stand in for agent and cloud**

```python
# edge/forwarder/tests/test_main_smoke.py
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
        url__regex=r"http://agent.test:5000/sample.*",
        text=(FIX / "mazak_sample_chunk2.xml").read_text(encoding="utf-8"),
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
```

- [ ] **Step 4: Run tests**

Run: `cd edge/forwarder && pytest -v`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add edge/forwarder/src/forwarder/main.py edge/forwarder/src/forwarder/config.py edge/forwarder/tests/test_main_smoke.py
git commit -m "feat(edge): forwarder orchestrator (probe -> current seed -> poll + forward loops)"
```

---

## Task 9: Forwarder Dockerfile

**Files:**
- Create: `edge/forwarder/Dockerfile`

- [ ] **Step 1: Write Dockerfile**

```dockerfile
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system mtconnect --gid 2000 \
 && useradd --system --gid mtconnect --uid 2000 --home /app mtconnect

WORKDIR /app

COPY pyproject.toml ./
COPY src/ ./src/

RUN pip install --no-cache-dir . \
 && mkdir -p /var/lib/mtconnect \
 && chown -R mtconnect:mtconnect /var/lib/mtconnect /app

USER mtconnect

VOLUME ["/var/lib/mtconnect"]

ENTRYPOINT ["forwarder"]
```

- [ ] **Step 2: Build locally**

```bash
cd edge/forwarder && podman build -t localhost/mtconnect-forwarder:dev .
```

Expected: image built.

- [ ] **Step 3: Commit**

```bash
git add edge/forwarder/Dockerfile
git commit -m "feat(edge): forwarder Dockerfile (rootless user, slim python)"
```

---

## Task 10: cppagent Devices.xml and agent.cfg

**Files:**
- Create: `edge/cppagent/agent.cfg`
- Create: `edge/cppagent/Devices.xml`
- Create: `edge/cppagent/devices/simulator-mazak.xml`

- [ ] **Step 1: Write `agent.cfg`**

```
Devices = Devices.xml
SchemaVersion = 2.7
WorkerThreads = 2
MonitorConfigFiles = yes
Port = 5000
ServerIp = 0.0.0.0
JsonVersion = 2
BufferSize = 17
MaxAssets = 1024
Validation = true

Adapters {
  Mazak01 {
    Host = simulator
    Port = 7878
  }
}

logger_config {
  output = cout
  level = warn
}
```

- [ ] **Step 2: Write a minimal `Devices.xml`** (derived from the NIST smstestbed example and the cppagent VMC-3Axis sample — here reduced to one Mazak-style device)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.7"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xsi:schemaLocation="urn:mtconnect.org:MTConnectDevices:2.7 http://schemas.mtconnect.org/schemas/MTConnectDevices_2.7.xsd">
  <Header creationTime="2026-04-22T10:00:00Z" sender="localhost" instanceId="1" bufferSize="131072" version="2.7"/>
  <Devices>
    <Device id="Mazak01" name="Mazak01" uuid="000-mazak-01">
      <Description manufacturer="Mazak" model="Integrex"/>
      <DataItems>
        <DataItem category="EVENT" id="avail" type="AVAILABILITY"/>
      </DataItems>
      <Components>
        <Controller id="ctrl" name="controller">
          <DataItems>
            <DataItem category="EVENT" id="mode" type="CONTROLLER_MODE"/>
            <DataItem category="EVENT" id="estop" type="EMERGENCY_STOP"/>
          </DataItems>
          <Components>
            <Path id="path" name="path">
              <DataItems>
                <DataItem category="EVENT" id="exec" type="EXECUTION"/>
                <DataItem category="EVENT" id="prog" type="PROGRAM"/>
                <DataItem category="EVENT" id="tool" type="TOOL_NUMBER"/>
                <DataItem category="EVENT" id="part" type="PART_COUNT" subType="ALL"/>
                <DataItem category="SAMPLE" id="feed" type="PATH_FEEDRATE" units="MILLIMETER/SECOND"/>
                <DataItem category="CONDITION" id="logic_cond" type="LOGIC_PROGRAM"/>
                <DataItem category="CONDITION" id="motion_cond" type="MOTION_PROGRAM"/>
                <DataItem category="CONDITION" id="system_cond" type="SYSTEM"/>
              </DataItems>
            </Path>
          </Components>
        </Controller>
        <Axes id="axes" name="base">
          <Components>
            <Rotary id="spindle" name="C">
              <DataItems>
                <DataItem category="SAMPLE" id="spindle_rpm" type="ROTARY_VELOCITY" units="REVOLUTION/MINUTE"/>
                <DataItem category="SAMPLE" id="spindle_load" type="LOAD" units="PERCENT"/>
              </DataItems>
            </Rotary>
          </Components>
        </Axes>
      </Components>
    </Device>
  </Devices>
</MTConnectDevices>
```

Tested for structural correctness against 2.7 schema by the cppagent container's `Validation = true` — any error will crash the agent on startup.

- [ ] **Step 3: Also copy to templates dir**

```bash
cp edge/cppagent/Devices.xml edge/cppagent/devices/simulator-mazak.xml
```

- [ ] **Step 4: Commit**

```bash
git add edge/cppagent/
git commit -m "feat(edge): cppagent config (agent.cfg, Devices.xml) for Mazak simulator"
```

---

## Task 11: Simulator replay harness

**Files:**
- Create: `edge/simulator/simulator.rb` (fetched from cppagent repo)
- Create: `edge/simulator/mazak.txt` (fetched from cppagent repo)
- Create: `edge/simulator/README.md`

- [ ] **Step 1: Fetch upstream simulator and trace**

```bash
mkdir -p edge/simulator
curl -o edge/simulator/simulator.rb https://raw.githubusercontent.com/mtconnect/cppagent/master/simulator/simulator.rb
curl -o edge/simulator/mazak.txt https://raw.githubusercontent.com/mtconnect/cppagent/master/demo/agent/mazak.txt
curl -o edge/simulator/okuma.txt https://raw.githubusercontent.com/mtconnect/cppagent/master/demo/agent/okuma.txt
```

- [ ] **Step 2: Write README**

```markdown
# edge/simulator

Replay SHDR traces from the cppagent demo corpus. Vendored from
https://github.com/mtconnect/cppagent (Apache-2.0) to keep our integration
tests reproducible without network access.

## Run

```bash
ruby simulator.rb 7878 < mazak.txt
```

The simulator listens on port 7878 and feeds SHDR lines to any connected
client (i.e., cppagent's adapter block pointing at it).
```

- [ ] **Step 3: Commit**

```bash
git add edge/simulator/
git commit -m "chore(edge): vendor cppagent simulator.rb + mazak/okuma SHDR traces"
```

---

## Task 12: podman-compose stack

**Files:**
- Create: `edge/compose/compose.yml`
- Create: `edge/compose/.env.example`

- [ ] **Step 1: Write compose.yml**

```yaml
version: "3.9"

services:
  simulator:
    image: ruby:3.3-slim
    working_dir: /sim
    volumes:
      - ../simulator:/sim:ro
    command: ["ruby", "-e", "load '/sim/simulator.rb'"]
    # simulator.rb needs port + input; override with an entrypoint that pipes the trace
    entrypoint: ["/bin/sh", "-c"]
    # send lines with artificial pacing
    command: ["cat /sim/mazak.txt | ruby /sim/simulator.rb 7878"]
    networks: [mtc]
    restart: unless-stopped

  cppagent:
    image: mtconnect/agent:2.7
    depends_on: [simulator]
    volumes:
      - ../cppagent:/mtconnect/config:ro
    ports:
      - "5000:5000"
    networks: [mtc]
    restart: unless-stopped

  forwarder:
    build:
      context: ../forwarder
    depends_on: [cppagent]
    environment:
      MTC_AGENT_URL: http://cppagent:5000
      MTC_CLOUD_URL: ${MTC_CLOUD_URL:?set MTC_CLOUD_URL in .env}
      MTC_EDGE_SECRET: ${MTC_EDGE_SECRET:?set MTC_EDGE_SECRET in .env}
      MTC_BUFFER_PATH: /var/lib/mtconnect/forwarder.sqlite
      MTC_POLL_INTERVAL_S: "1.0"
    volumes:
      - forwarder-data:/var/lib/mtconnect
    networks: [mtc]
    restart: unless-stopped

networks:
  mtc:
    driver: bridge

volumes:
  forwarder-data:
```

- [ ] **Step 2: Write .env.example**

```
MTC_CLOUD_URL=http://host.containers.internal:8787
MTC_EDGE_SECRET=test-secret
```

- [ ] **Step 3: Local smoke test (manual)**

In two terminals:
- Terminal 1: `cd cloud && npm run dev` (starts the Worker on :8787 per Phase 1)
- Terminal 2: `cd edge/compose && cp .env.example .env && podman-compose up --build`

Wait ~60s, then hit `http://localhost:8787/machines`. Expect `Mazak01` in the list, with `last_observation_ts` updating each call.

- [ ] **Step 4: Commit**

```bash
git add edge/compose/
git commit -m "feat(edge): podman-compose stack (simulator + cppagent + forwarder)"
```

---

## Task 13: Ansible baseline playbook

**Files:**
- Create: `edge/ansible/inventory.example.ini`
- Create: `edge/ansible/playbook.yml`
- Create: `edge/ansible/roles/baseline/tasks/main.yml`
- Create: `edge/ansible/roles/podman/tasks/main.yml`
- Create: `edge/ansible/roles/monitoring_vlan/tasks/main.yml`
- Create: `edge/ansible/roles/mtconnect_stack/tasks/main.yml`
- Create: `edge/ansible/README.md`

- [ ] **Step 1: Write `playbook.yml`**

```yaml
---
- name: MTConnect NUC baseline + stack
  hosts: nucs
  become: true
  vars:
    mtconnect_user: mtconnect
    mtconnect_uid: 2000
    monitoring_vlan_interface: "{{ monitoring_vlan_interface | default('') }}"
  roles:
    - baseline
    - podman
    - monitoring_vlan
    - mtconnect_stack
```

- [ ] **Step 2: Write `roles/baseline/tasks/main.yml`**

```yaml
---
- name: Ensure essential packages
  ansible.builtin.apt:
    name:
      - ufw
      - chrony
      - auditd
      - unattended-upgrades
      - apt-listchanges
      - htop
      - rsync
      - curl
      - jq
      - fail2ban
    state: present
    update_cache: yes

- name: Enable and start auditd
  ansible.builtin.service:
    name: auditd
    state: started
    enabled: yes

- name: Enable unattended upgrades
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
      APT::Periodic::AutocleanInterval "7";
    mode: "0644"

- name: Ensure SSH password auth is off
  ansible.builtin.lineinfile:
    path: /etc/ssh/sshd_config
    regexp: '^#?PasswordAuthentication'
    line: 'PasswordAuthentication no'
  notify: restart sshd

- name: Ensure SSH root login disabled
  ansible.builtin.lineinfile:
    path: /etc/ssh/sshd_config
    regexp: '^#?PermitRootLogin'
    line: 'PermitRootLogin no'
  notify: restart sshd

- name: Enable chrony
  ansible.builtin.service:
    name: chrony
    state: started
    enabled: yes

- name: Configure UFW baseline
  block:
    - ansible.builtin.command: ufw default deny incoming
      changed_when: false
    - ansible.builtin.command: ufw default allow outgoing
      changed_when: false
    - ansible.builtin.command: ufw allow 22/tcp
      changed_when: false
    - ansible.builtin.command: ufw --force enable
      changed_when: false

- name: Create mtconnect user
  ansible.builtin.user:
    name: "{{ mtconnect_user }}"
    uid: "{{ mtconnect_uid }}"
    shell: /usr/sbin/nologin
    system: yes
    create_home: no

- name: Ensure subuid/subgid mappings
  ansible.builtin.lineinfile:
    path: "{{ item.path }}"
    line: "{{ mtconnect_user }}:100000:65536"
    create: yes
    mode: "0644"
  loop:
    - { path: /etc/subuid }
    - { path: /etc/subgid }
```

Handlers file:

```yaml
# edge/ansible/roles/baseline/handlers/main.yml
---
- name: restart sshd
  ansible.builtin.service:
    name: ssh
    state: restarted
```

- [ ] **Step 3: Write `roles/podman/tasks/main.yml`**

```yaml
---
- name: Install podman + compose
  ansible.builtin.apt:
    name:
      - podman
      - podman-compose
      - slirp4netns
      - uidmap
    state: present
    update_cache: yes

- name: Enable lingering for mtconnect user (so rootless services persist)
  ansible.builtin.command: "loginctl enable-linger {{ mtconnect_user }}"
  args:
    creates: "/var/lib/systemd/linger/{{ mtconnect_user }}"
```

- [ ] **Step 4: Write `roles/monitoring_vlan/tasks/main.yml`**

```yaml
---
- name: Skip if no VLAN interface configured
  ansible.builtin.meta: end_play
  when: monitoring_vlan_interface | length == 0

- name: Install VLAN package
  ansible.builtin.apt:
    name: vlan
    state: present

- name: Ensure 8021q module loaded at boot
  ansible.builtin.lineinfile:
    path: /etc/modules
    line: "8021q"
    create: yes
    mode: "0644"

- name: Netplan config for monitoring VLAN
  ansible.builtin.copy:
    dest: /etc/netplan/60-mtc-monitoring-vlan.yaml
    content: |
      network:
        version: 2
        vlans:
          {{ monitoring_vlan_interface }}:
            id: {{ monitoring_vlan_id }}
            link: {{ monitoring_vlan_link }}
            dhcp4: true
    mode: "0600"
  notify: netplan apply

- name: UFW allow monitoring VLAN to cppagent port (for adapter origin)
  ansible.builtin.command: ufw allow in on {{ monitoring_vlan_interface }} to any port 5000 proto tcp
  changed_when: false
```

Handlers:

```yaml
# edge/ansible/roles/monitoring_vlan/handlers/main.yml
---
- name: netplan apply
  ansible.builtin.command: netplan apply
```

- [ ] **Step 5: Write `roles/mtconnect_stack/tasks/main.yml`**

```yaml
---
- name: Sync stack files to /opt/mtconnect
  ansible.builtin.synchronize:
    src: "{{ playbook_dir }}/../"
    dest: /opt/mtconnect/
    rsync_opts:
      - "--exclude=.git"
      - "--exclude=ansible"
      - "--exclude=forwarder/tests"
  become: true

- name: Ensure stack owned by mtconnect
  ansible.builtin.file:
    path: /opt/mtconnect
    owner: "{{ mtconnect_user }}"
    group: "{{ mtconnect_user }}"
    recurse: yes

- name: Ensure .env present
  ansible.builtin.copy:
    dest: /opt/mtconnect/compose/.env
    content: |
      MTC_CLOUD_URL={{ mtc_cloud_url }}
      MTC_EDGE_SECRET={{ mtc_edge_secret }}
    owner: "{{ mtconnect_user }}"
    group: "{{ mtconnect_user }}"
    mode: "0600"

- name: Deploy systemd unit to run podman-compose on boot
  ansible.builtin.copy:
    dest: /etc/systemd/system/mtconnect-stack.service
    content: |
      [Unit]
      Description=MTConnect edge stack (podman-compose)
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User={{ mtconnect_user }}
      WorkingDirectory=/opt/mtconnect/compose
      ExecStart=/usr/bin/podman-compose up
      ExecStop=/usr/bin/podman-compose down
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=multi-user.target
    mode: "0644"
  notify: reload systemd

- name: Enable mtconnect-stack
  ansible.builtin.service:
    name: mtconnect-stack
    state: started
    enabled: yes
```

Handlers:

```yaml
# edge/ansible/roles/mtconnect_stack/handlers/main.yml
---
- name: reload systemd
  ansible.builtin.systemd:
    daemon_reload: yes
```

- [ ] **Step 6: Inventory example**

```ini
# edge/ansible/inventory.example.ini
[nucs]
nuc-shop-1 ansible_host=10.0.20.10 ansible_user=tal

[nucs:vars]
mtc_cloud_url=https://mtconnect.ffmfg.com
mtc_edge_secret=REPLACE_FROM_VAULT
monitoring_vlan_interface=eth0.20
monitoring_vlan_id=20
monitoring_vlan_link=eth0
```

- [ ] **Step 7: README**

```markdown
# edge/ansible

Provisions the Ubuntu 24.04 NUC baseline and deploys the mtconnect stack.

## Usage

```bash
cp inventory.example.ini inventory.ini
# edit inventory.ini with your NUC hostname/IP and vault-sourced secrets
ansible-playbook -i inventory.ini playbook.yml --check  # dry-run
ansible-playbook -i inventory.ini playbook.yml          # apply
```

## What it configures

- **baseline**: essential packages, auditd, unattended-upgrades, SSH hardening, chrony, UFW deny-by-default + allow 22
- **podman**: podman + podman-compose + rootless prerequisites, lingering for mtconnect user
- **monitoring_vlan**: (optional) VLAN tagged interface via netplan
- **mtconnect_stack**: sync repo to /opt/mtconnect, systemd unit to run podman-compose on boot

## CMMC posture (Phase 1)

- FDE assumed pre-install (LUKS at Ubuntu install time)
- SSH keys only, password auth off
- auditd enabled with default rules
- UFW default-deny
- rootless containers
- monitoring VLAN keeps machine traffic off the main network
```

- [ ] **Step 8: Smoke-test playbook syntax**

```bash
cd edge/ansible && ansible-playbook playbook.yml --syntax-check -i inventory.example.ini
```

Expected: `playbook: playbook.yml` without errors (requires Ansible installed).

- [ ] **Step 9: Commit**

```bash
git add edge/ansible/
git commit -m "feat(edge): Ansible baseline playbook (baseline, podman, VLAN, stack)"
```

---

## Task 14: End-to-end local smoke test documentation

**Files:**
- Create: `edge/README.md`

- [ ] **Step 1: Write edge/README.md**

```markdown
# edge

## Local end-to-end smoke test (no real machine)

### Prerequisites

- podman + podman-compose
- Python 3.12 + this repo's edge/forwarder installed
- Cloud worker running locally (see `cloud/README.md` for `npm run dev`)
- Ruby 3.x (optional — used by compose's `simulator` service)

### Run

```bash
cd cloud && npm run dev &                           # terminal 1
cd edge/compose && cp .env.example .env && podman-compose up --build   # terminal 2
```

Expected:

- `simulator` container opens SHDR listener on :7878 within the compose network, piping mazak.txt
- `cppagent` container connects and exposes :5000 (mapped to host :5000)
- `forwarder` container fetches /probe, seeds cursor from /current, polls /sample, POSTs to http://host.containers.internal:8787

Verify:

```bash
curl http://localhost:5000/probe | head -20        # cppagent is up
curl http://localhost:8787/machines                # cloud has received the probe
curl http://localhost:8787/machines/000-mazak-01/current   # observations flowing
```

### Tear down

```bash
cd edge/compose && podman-compose down -v
```

## Unit tests

```bash
cd edge/forwarder && pytest -v
```
```

- [ ] **Step 2: Commit**

```bash
git add edge/README.md
git commit -m "docs(edge): local smoke test runbook"
```

---

## Task 15: Final sanity — everything green

- [ ] **Step 1: Run forwarder tests**

Run: `cd edge/forwarder && pytest -v`
Expected: all passing.

- [ ] **Step 2: Run full cloud test suite (Phase 1 regression)**

Run: `cd cloud && npm test`
Expected: all passing.

- [ ] **Step 3: (Optional) Run end-to-end smoke test**

Follow `edge/README.md` runbook, verify `curl http://localhost:8787/machines/000-mazak-01/current` returns ACTIVE/READY transitions.

- [ ] **Step 4: No commit** — sanity gate only.

---

## Done

After Task 15:
- Forwarder installs, tests pass, Docker image builds
- cppagent runs with a valid Devices.xml against the Mazak SHDR replay trace
- podman-compose orchestrates simulator + cppagent + forwarder end-to-end
- Ansible playbook provisions NUC baseline with CMMC-aware posture
- End-to-end flow (simulator → cppagent → forwarder → cloud Worker) works on a laptop with no real machine

Ready for Phase 3 (first Haas on real NUC).
