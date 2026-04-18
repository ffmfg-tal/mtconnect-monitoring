import { Hono } from "hono";
import type { Env } from "../types";

export const alertsRead = new Hono<{ Bindings: Env }>();

alertsRead.get("/", async (c) => {
  const includeCleared = c.req.query("include_cleared") === "1";
  const where = includeCleared ? "" : "WHERE cleared_at IS NULL";
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.machine_id, m.display_name AS machine_name, a.kind, a.triggered_at,
            a.cleared_at, a.severity, a.message, a.acknowledged_by, a.acknowledged_at
     FROM alerts a
     LEFT JOIN machines m ON m.id = a.machine_id
     ${where}
     ORDER BY a.triggered_at DESC
     LIMIT 200`,
  ).all();
  return c.json({ alerts: rows.results });
});

alertsRead.post("/:id/ack", async (c) => {
  const id = Number(c.req.param("id"));
  const { user } = (await c.req.json()) as { user?: string };
  if (!user) return c.json({ error: "user required" }, 400);

  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `UPDATE alerts
     SET acknowledged_by = ?, acknowledged_at = ?
     WHERE id = ? AND acknowledged_by IS NULL`,
  )
    .bind(user, now, id)
    .run();

  return c.json({ acknowledged: res.meta.changes > 0 });
});
