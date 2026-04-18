import { Hono } from "hono";
import type { Env } from "../types";

export const oeeRead = new Hono<{ Bindings: Env }>();

oeeRead.get("/:id/oee", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);

  const row = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(active_seconds), 0)      AS active_seconds,
       COALESCE(SUM(feed_hold_seconds), 0)   AS feed_hold_seconds,
       COALESCE(SUM(stopped_seconds), 0)     AS stopped_seconds,
       COALESCE(SUM(offline_seconds), 0)     AS offline_seconds,
       COALESCE(SUM(part_count_delta), 0)    AS part_count
     FROM rollups_minute
     WHERE machine_id = ?
       AND minute_bucket >= ?
       AND minute_bucket < ?`,
  )
    .bind(id, `${date}T00:00:00Z`, `${date}T23:59:59Z`)
    .first<{
      active_seconds: number;
      feed_hold_seconds: number;
      stopped_seconds: number;
      offline_seconds: number;
      part_count: number;
    }>();

  const active = row?.active_seconds ?? 0;
  const feedHold = row?.feed_hold_seconds ?? 0;
  const stopped = row?.stopped_seconds ?? 0;
  const offline = row?.offline_seconds ?? 0;
  const scheduled = 8 * 3600;

  const availability = scheduled > 0 ? (active + feedHold) / scheduled : 0;
  const utilization = scheduled > 0 ? active / scheduled : 0;

  return c.json({
    machine_id: id,
    date,
    active_seconds: active,
    feed_hold_seconds: feedHold,
    stopped_seconds: stopped,
    offline_seconds: offline,
    scheduled_seconds: scheduled,
    availability,
    utilization,
    part_count: row?.part_count ?? 0,
  });
});
