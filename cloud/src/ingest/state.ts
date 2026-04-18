import { Hono } from "hono";
import type { Env, StateIntervalIn } from "../types";
import { distinctMachineIds } from "../db";

export const stateIngest = new Hono<{ Bindings: Env }>();

stateIngest.post("/", async (c) => {
  const body = (await c.req.json()) as StateIntervalIn[];
  if (!Array.isArray(body)) return c.json({ error: "expected array" }, 400);
  if (body.length === 0) return c.json({ inserted: 0 });

  const uniqMachines = Array.from(new Set(body.map((r) => r.machine_id)));
  const known = await distinctMachineIds(c.env, uniqMachines);
  for (const id of uniqMachines) {
    if (!known.has(id)) return c.json({ error: `unknown machine_id: ${id}` }, 400);
  }

  const stmts = body.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO state_intervals
         (machine_id, state, started_at, ended_at, duration_seconds, program, tool_number, inferred_job_id, inferred_op_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT DO NOTHING`,
    ).bind(
      r.machine_id,
      r.state,
      r.started_at,
      r.ended_at,
      r.duration_seconds,
      r.program ?? null,
      r.tool_number ?? null,
    ),
  );
  await c.env.DB.batch(stmts);

  return c.json({ inserted: body.length });
});
