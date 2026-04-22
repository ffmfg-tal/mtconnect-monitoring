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
