// cloud/scripts/demo-poller.ts
// Dev-only: polls demo.mtconnect.org and posts to a local Worker.
// Usage: npm run poll:demo -- --base http://localhost:8787 --secret test-secret

import { parseProbe } from "../src/xml/probe";
import { parseStreams } from "../src/xml/streams";

type Args = { base: string; secret: string; interval: number };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (name: string, def?: string) => {
    const idx = args.findIndex((a) => a === `--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  };
  return {
    base: get("base", "http://localhost:8787")!,
    secret: get("secret", "test-secret")!,
    interval: Number(get("interval", "5000")!),
  };
}

async function postJson(url: string, secret: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Edge-Secret": secret,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`POST ${url} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const { base, secret, interval } = parseArgs();
  console.log(`demo-poller: base=${base} interval=${interval}ms`);

  const probeXml = await fetchText("https://demo.mtconnect.org/probe");
  const probe = parseProbe(probeXml);

  for (const d of probe.devices) {
    await postJson(`${base}/ingest/probe`, secret, {
      device_uuid: d.uuid,
      name: d.name,
      model: d.model ?? null,
      controller_type: null,
      controller_vendor: null,
      mtconnect_version: probe.header.schemaVersion,
      instance_id: probe.header.instanceId,
      probe_xml: probeXml,
      data_items: d.dataItems,
    });
  }
  console.log(`posted probe for ${probe.devices.length} device(s)`);

  const currentXml = await fetchText("https://demo.mtconnect.org/current");
  const firstStreams = parseStreams(currentXml);
  const cursors = new Map<string, number>();
  for (const d of probe.devices) {
    cursors.set(d.uuid, firstStreams.header.nextSequence);
  }

  while (true) {
    try {
      for (const d of probe.devices) {
        const from = cursors.get(d.uuid)!;
        const xml = await fetchText(
          `https://demo.mtconnect.org/sample?from=${from}&count=1000`,
        );
        const parsed = parseStreams(xml);
        const forDevice = parsed.observations.filter(
          (o) => o.deviceUuid === d.uuid,
        );
        if (forDevice.length > 0) {
          await postJson(`${base}/ingest/observations`, secret, {
            device_uuid: d.uuid,
            instance_id: parsed.header.instanceId,
            batch: forDevice.map((o) => ({
              sequence: o.sequence,
              timestamp: o.timestamp,
              data_item_id: o.dataItemId,
              category: o.category,
              type: o.type,
              sub_type: o.subType,
              value_num: o.valueNum,
              value_str: o.valueStr,
              condition_level: o.conditionLevel,
              condition_native_code: o.conditionNativeCode,
              condition_severity: o.conditionSeverity,
              condition_qualifier: o.conditionQualifier,
            })),
          });
          console.log(
            `${d.name}: posted ${forDevice.length} obs, next=${parsed.header.nextSequence}`,
          );
        }
        cursors.set(d.uuid, parsed.header.nextSequence);
      }
    } catch (e) {
      console.error("poll error", e);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

main();
