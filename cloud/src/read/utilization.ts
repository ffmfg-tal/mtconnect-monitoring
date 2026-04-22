import { Hono } from "hono";
import type { Env } from "../types";

export const utilizationRead = new Hono<{ Bindings: Env }>();

utilizationRead.get("/:id/utilization", async (c) => {
  const id = c.req.param("id");
  const date = c.req.query("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date=YYYY-MM-DD required" }, 400);
  }
  const from = `${date}T00:00:00Z`;
  const to = `${date}T23:59:59Z`;
  const row = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(active_s), 0) AS active_s,
       COALESCE(SUM(feed_hold_s), 0) AS feed_hold_s,
       COALESCE(SUM(part_delta), 0) AS part_count
     FROM rollups_minute
     WHERE device_uuid = ?
       AND datetime(minute_start) >= datetime(?)
       AND datetime(minute_start) <= datetime(?)`,
  )
    .bind(id, from, to)
    .first<{ active_s: number; feed_hold_s: number; part_count: number }>();

  const scheduledSeconds = 8 * 3600;
  const active = row?.active_s ?? 0;
  const feedHold = row?.feed_hold_s ?? 0;
  return c.json({
    device_uuid: id,
    date,
    scheduled_seconds: scheduledSeconds,
    availability_pct: (active + feedHold) / scheduledSeconds,
    utilization_pct: active / scheduledSeconds,
    part_count: row?.part_count ?? 0,
    note: "utilization only — true OEE requires Performance and Quality legs (see spec § Out of scope)",
  });
});
