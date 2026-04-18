import { Hono } from "hono";
import type { Env, EventIn } from "../types";
import { distinctMachineIds } from "../db";

export const eventsIngest = new Hono<{ Bindings: Env }>();

eventsIngest.post("/", async (c) => {
  const body = (await c.req.json()) as EventIn[];
  if (!Array.isArray(body)) return c.json({ error: "expected array" }, 400);
  if (body.length === 0) return c.json({ inserted: 0 });

  const uniqMachines = Array.from(new Set(body.map((r) => r.machine_id)));
  const known = await distinctMachineIds(c.env, uniqMachines);
  for (const id of uniqMachines) {
    if (!known.has(id)) return c.json({ error: `unknown machine_id: ${id}` }, 400);
  }

  const stmts = body.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO events (machine_id, ts, kind, severity, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      r.machine_id,
      r.ts,
      r.kind,
      r.severity,
      r.payload ? JSON.stringify(r.payload) : null,
    ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ inserted: body.length });
});
