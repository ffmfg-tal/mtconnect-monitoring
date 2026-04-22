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
