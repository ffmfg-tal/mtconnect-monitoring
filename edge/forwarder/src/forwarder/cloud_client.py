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
