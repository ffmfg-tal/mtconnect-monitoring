import { Hono } from "hono";
import type { Env } from "../types";

type ObservationIn = {
  sequence: number;
  timestamp: string;
  data_item_id: string;
  category: "SAMPLE" | "EVENT" | "CONDITION";
  type: string;
  sub_type?: string;
  value_num?: number | null;
  value_str?: string | null;
  condition_level?: "NORMAL" | "WARNING" | "FAULT" | "UNAVAILABLE";
  condition_native_code?: string;
  condition_severity?: string;
  condition_qualifier?: string;
};

type Body = {
  device_uuid: string;
  instance_id: string;
  batch: ObservationIn[];
  gap?: { start_seq: number; end_seq: number };
};

export const observationsIngest = new Hono<{ Bindings: Env }>();

observationsIngest.post("/", async (c) => {
  const b = (await c.req.json<Body>().catch(() => null)) as Body | null;
  if (!b || !b.device_uuid || !b.instance_id || !Array.isArray(b.batch)) {
    return c.json({ error: "invalid body" }, 400);
  }

  // device existence check
  const dev = await c.env.DB.prepare(
    "SELECT current_instance_id FROM devices WHERE device_uuid = ?",
  )
    .bind(b.device_uuid)
    .first<{ current_instance_id: string | null }>();
  if (!dev) {
    return c.json({ error: "unknown device" }, 400);
  }

  const stmts: D1PreparedStatement[] = [];

  if (dev.current_instance_id !== b.instance_id) {
    stmts.push(
      c.env.DB.prepare(
        "UPDATE devices SET current_instance_id = ?, updated_at = ? WHERE device_uuid = ?",
      ).bind(b.instance_id, new Date().toISOString(), b.device_uuid),
    );
  }

  let high = 0;
  for (const o of b.batch) {
    if (o.sequence > high) high = o.sequence;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO observations (device_uuid, sequence, timestamp_utc, data_item_id, value_num, value_str, condition_level, condition_native_code, condition_severity, condition_qualifier)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (device_uuid, sequence) DO UPDATE SET
           timestamp_utc = excluded.timestamp_utc,
           data_item_id = excluded.data_item_id,
           value_num = excluded.value_num,
           value_str = excluded.value_str,
           condition_level = excluded.condition_level,
           condition_native_code = excluded.condition_native_code,
           condition_severity = excluded.condition_severity,
           condition_qualifier = excluded.condition_qualifier`,
      ).bind(
        b.device_uuid,
        o.sequence,
        o.timestamp,
        o.data_item_id,
        o.value_num ?? null,
        o.value_str ?? null,
        o.condition_level ?? null,
        o.condition_native_code ?? null,
        o.condition_severity ?? null,
        o.condition_qualifier ?? null,
      ),
    );
  }

  if (b.gap) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO events (device_uuid, ts, kind, payload_json) VALUES (?,?,?,?)
         ON CONFLICT (device_uuid, ts, kind) DO NOTHING`,
      ).bind(
        b.device_uuid,
        new Date().toISOString(),
        "gap",
        JSON.stringify(b.gap),
      ),
    );
  }

  await c.env.DB.batch(stmts);

  return c.json({ ok: true, high_water_sequence: high });
});
