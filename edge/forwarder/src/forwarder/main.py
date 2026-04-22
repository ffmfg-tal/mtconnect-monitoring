from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from forwarder.agent_client import AgentClient
from forwarder.buffer import ObservationBuffer
from forwarder.cloud_client import CloudClient
from forwarder.config import Config
from forwarder.probe import ProbeResult, parse_probe
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
    probe: ProbeResult,
    config: Config,
) -> None:
    while True:
        for device in probe.devices:
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
