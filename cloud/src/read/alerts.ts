import { Hono } from "hono";
import type { Env } from "../types";

export const alertsRead = new Hono<{ Bindings: Env }>();

alertsRead.get("/", async (c) => {
  const includeCleared = c.req.query("include_cleared") === "1";
  const sql = includeCleared
    ? "SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT 500"
    : "SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY triggered_at DESC LIMIT 500";
  const res = await c.env.DB.prepare(sql).all();
  return c.json({ alerts: res.results });
});

alertsRead.post("/:id/ack", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
  const body =
    (await c.req.json<{ acknowledged_by?: string }>().catch(() => ({}))) ?? {};
  const by = body.acknowledged_by ?? "unknown";
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    "UPDATE alerts SET acknowledged_by = COALESCE(acknowledged_by, ?), acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?",
  )
    .bind(by, now, id)
    .run();
  if (res.meta.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
