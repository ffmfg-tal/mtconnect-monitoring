"""MTConnect /current parser.

Consumes an MTConnectStreams XML document and returns a flat snapshot of the
signals we care about for Phase 1 MVP: execution, program, tool, part count,
active faults, E-stop.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

_UNAVAILABLE = {"UNAVAILABLE", ""}


@dataclass(frozen=True)
class ActiveFault:
    type: str
    message: str
    native_code: str | None
    severity: str | None


@dataclass(frozen=True)
class CurrentSnapshot:
    device_uuid: str
    creation_time: datetime
    execution: str
    controller_mode: str | None = None
    program: str | None = None
    tool_number: int | None = None
    part_count: int | None = None
    spindle_rpm: float | None = None
    path_feedrate: float | None = None
    emergency_stop: str | None = None
    active_faults: list[ActiveFault] = field(default_factory=list)


def _local_name(el: ET.Element) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    # MTConnect uses ISO-8601 like "2026-04-20T14:00:30Z"
    # Python 3.12 fromisoformat handles Z natively.
    return datetime.fromisoformat(value).astimezone(timezone.utc)


def _value_or_none(el: ET.Element) -> str | None:
    text = (el.text or "").strip()
    if text.upper() in _UNAVAILABLE:
        return None
    return text


def _int_or_none(el: ET.Element) -> int | None:
    text = _value_or_none(el)
    if text is None:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _float_or_none(el: ET.Element) -> float | None:
    text = _value_or_none(el)
    if text is None:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_current(xml: bytes | str) -> CurrentSnapshot:
    root = ET.fromstring(xml)

    header = next(
        (e for e in root.iter() if _local_name(e) == "Header"),
        None,
    )
    creation_time = _parse_ts(header.get("creationTime")) if header is not None else None
    if creation_time is None:
        creation_time = datetime.now(tz=timezone.utc)

    device_stream = next(
        (e for e in root.iter() if _local_name(e) == "DeviceStream"),
        None,
    )
    if device_stream is None:
        raise ValueError("no DeviceStream in MTConnect response")
    device_uuid = device_stream.get("uuid") or device_stream.get("name") or "unknown"

    execution = "UNAVAILABLE"
    controller_mode: str | None = None
    program: str | None = None
    tool_number: int | None = None
    part_count: int | None = None
    spindle_rpm: float | None = None
    path_feedrate: float | None = None
    emergency_stop: str | None = None
    active_faults: list[ActiveFault] = []

    for el in device_stream.iter():
        name = _local_name(el)

        if name == "Execution":
            execution = (el.text or "UNAVAILABLE").strip().upper() or "UNAVAILABLE"
        elif name == "ControllerMode":
            controller_mode = _value_or_none(el)
        elif name == "Program":
            program = _value_or_none(el)
        elif name in ("ToolNumber", "ToolAssetId"):
            tool_number = _int_or_none(el) if tool_number is None else tool_number
        elif name == "PartCount":
            part_count = _int_or_none(el)
        elif name == "RotaryVelocity" and el.get("subType", "ACTUAL").upper() == "ACTUAL":
            spindle_rpm = _float_or_none(el)
        elif name == "PathFeedrate":
            path_feedrate = _float_or_none(el)
        elif name == "EmergencyStop":
            emergency_stop = _value_or_none(el)
        elif name in ("Fault", "Warning"):
            active_faults.append(
                ActiveFault(
                    type=el.get("type", "UNKNOWN"),
                    message=(el.text or "").strip(),
                    native_code=el.get("nativeCode"),
                    severity=el.get("severity") or (name.upper() if name == "Fault" else "WARNING"),
                )
            )

    return CurrentSnapshot(
        device_uuid=device_uuid,
        creation_time=creation_time,
        execution=execution,
        controller_mode=controller_mode,
        program=program,
        tool_number=tool_number,
        part_count=part_count,
        spindle_rpm=spindle_rpm,
        path_feedrate=path_feedrate,
        emergency_stop=emergency_stop,
        active_faults=active_faults,
    )
