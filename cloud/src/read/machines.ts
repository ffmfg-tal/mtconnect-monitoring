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
