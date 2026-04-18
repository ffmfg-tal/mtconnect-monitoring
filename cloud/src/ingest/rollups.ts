import { Hono } from "hono";
import type { Env, RollupMinuteIn } from "../types";
import { distinctMachineIds } from "../db";

export const rollupsIngest = new Hono<{ Bindings: Env }>();

rollupsIngest.post("/", async (c) => {
  const body = (await c.req.json()) as RollupMinuteIn[];
  if (!Array.isArray(body)) return c.json({ error: "expected array" }, 400);
  if (body.length === 0) return c.json({ inserted: 0 });

  const uniqMachines = Array.from(new Set(body.map((r) => r.machine_id)));
  const known = await distinctMachineIds(c.env, uniqMachines);
  for (const id of uniqMachines) {
    if (!known.has(id)) return c.json({ error: `unknown machine_id: ${id}` }, 400);
  }

  const stmts = body.map((r) =>
    c.env.DB.prepare(
      `INSERT INTO rollups_minute
         (machine_id, minute_bucket, active_seconds, feed_hold_seconds, stopped_seconds,
          interrupted_seconds, offline_seconds, spindle_rpm_avg, spindle_load_avg,
          spindle_load_max, feedrate_avg, feed_override_avg, part_count_delta, program, tool_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, minute_bucket) DO UPDATE SET
         active_seconds = excluded.active_seconds,
         feed_hold_seconds = excluded.feed_hold_seconds,
         stopped_seconds = excluded.stopped_seconds,
         interrupted_seconds = excluded.interrupted_seconds,
         offline_seconds = excluded.offline_seconds,
         spindle_rpm_avg = excluded.spindle_rpm_avg,
         spindle_load_avg = excluded.spindle_load_avg,
         spindle_load_max = excluded.spindle_load_max,
         feedrate_avg = excluded.feedrate_avg,
         feed_override_avg = excluded.feed_override_avg,
         part_count_delta = excluded.part_count_delta,
         program = excluded.program,
         tool_number = excluded.tool_number`,
    ).bind(
      r.machine_id,
      r.minute_bucket,
      r.active_seconds,
      r.feed_hold_seconds,
      r.stopped_seconds,
      r.interrupted_seconds,
      r.offline_seconds,
      r.spindle_rpm_avg ?? null,
      r.spindle_load_avg ?? null,
      r.spindle_load_max ?? null,
      r.feedrate_avg ?? null,
      r.feed_override_avg ?? null,
      r.part_count_delta,
      r.program ?? null,
      r.tool_number ?? null,
    ),
  );
  await c.env.DB.batch(stmts);
  return c.json({ inserted: body.length });
});
