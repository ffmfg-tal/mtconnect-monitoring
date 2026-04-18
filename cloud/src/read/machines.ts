import { Hono } from "hono";
import type { Env } from "../types";

export const machinesRead = new Hono<{ Bindings: Env }>();

machinesRead.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT
       m.id, m.display_name, m.controller_kind, m.pool, m.ip, m.fulcrum_equip_id,
       (SELECT state FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS current_state,
       (SELECT ended_at FROM state_intervals si WHERE si.machine_id = m.id
          ORDER BY started_at DESC LIMIT 1) AS last_seen_at
     FROM machines m
     WHERE m.enabled = 1
     ORDER BY m.pool, m.display_name`,
  ).all();
  return c.json({ machines: rows.results });
});
