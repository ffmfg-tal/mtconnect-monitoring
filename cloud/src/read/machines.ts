import { Hono } from "hono";
import type { Env } from "../types";

export const machinesRead = new Hono<{ Bindings: Env }>();

machinesRead.get("/", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT d.device_uuid, d.name, d.model, d.controller_type, d.controller_vendor,
            (SELECT MAX(timestamp_utc) FROM observations o WHERE o.device_uuid = d.device_uuid) AS last_observation_ts
     FROM devices d
     ORDER BY d.name`,
  ).all();
  return c.json({ machines: res.results });
});

machinesRead.get("/:id/sample", async (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const typesCsv = c.req.query("types");
  if (!from || !to) return c.json({ error: "from and to required" }, 400);

  const types = typesCsv
    ? typesCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  // Compare timestamps by their datetime value so that .000Z-suffixed
  // stored timestamps match ISO queries without milliseconds.
  let sql = `SELECT o.sequence, o.timestamp_utc, o.data_item_id, o.value_num, o.value_str, o.condition_level, di.type
             FROM observations o
             JOIN data_items di ON di.device_uuid = o.device_uuid AND di.data_item_id = o.data_item_id
             WHERE o.device_uuid = ?
               AND datetime(o.timestamp_utc) >= datetime(?)
               AND datetime(o.timestamp_utc) <= datetime(?)`;
  const bindings: unknown[] = [id, from, to];
  if (types && types.length > 0) {
    const placeholders = types.map(() => "?").join(",");
    sql += ` AND di.type IN (${placeholders})`;
    bindings.push(...types);
  }
  sql += " ORDER BY o.timestamp_utc, o.sequence LIMIT 10000";
  const res = await c.env.DB.prepare(sql)
    .bind(...bindings)
    .all();
  return c.json({ device_uuid: id, observations: res.results });
});

machinesRead.get("/:id/current", async (c) => {
  const id = c.req.param("id");
  const dev = await c.env.DB.prepare(
    "SELECT device_uuid FROM devices WHERE device_uuid = ?",
  )
    .bind(id)
    .first();
  if (!dev) return c.json({ error: "not found" }, 404);
  const res = await c.env.DB.prepare(
    `SELECT o.data_item_id, o.timestamp_utc, o.value_num, o.value_str,
            o.condition_level, o.condition_native_code, o.condition_severity,
            di.category, di.type, di.sub_type
     FROM observations o
     JOIN data_items di ON di.device_uuid = o.device_uuid AND di.data_item_id = o.data_item_id
     WHERE o.device_uuid = ?
       AND o.sequence = (
         SELECT MAX(sequence) FROM observations o2
         WHERE o2.device_uuid = o.device_uuid AND o2.data_item_id = o.data_item_id
       )`,
  )
    .bind(id)
    .all();
  return c.json({ device_uuid: id, observations: res.results });
});
