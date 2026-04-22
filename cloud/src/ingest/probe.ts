import { Hono } from "hono";
import type { Env } from "../types";

type Body = {
  device_uuid: string;
  name: string;
  model?: string | null;
  controller_type?: string | null;
  controller_vendor?: string | null;
  mtconnect_version?: string | null;
  instance_id: string;
  probe_xml: string;
  data_items: Array<{
    id: string;
    category: string;
    type: string;
    subType?: string;
    units?: string;
    nativeUnits?: string;
    componentPath: string;
  }>;
};

export const probeIngest = new Hono<{ Bindings: Env }>();

probeIngest.post("/", async (c) => {
  const b = (await c.req.json<Body>().catch(() => null)) as Body | null;
  if (!b || !b.device_uuid || !b.instance_id || !Array.isArray(b.data_items)) {
    return c.json({ error: "invalid body" }, 400);
  }

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO devices (device_uuid, name, model, controller_type, controller_vendor, mtconnect_version, current_instance_id, probe_xml, probe_fetched_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (device_uuid) DO UPDATE SET
         name = excluded.name,
         model = excluded.model,
         controller_type = excluded.controller_type,
         controller_vendor = excluded.controller_vendor,
         mtconnect_version = excluded.mtconnect_version,
         current_instance_id = excluded.current_instance_id,
         probe_xml = excluded.probe_xml,
         probe_fetched_at = excluded.probe_fetched_at,
         updated_at = excluded.updated_at`,
    ).bind(
      b.device_uuid,
      b.name,
      b.model ?? null,
      b.controller_type ?? null,
      b.controller_vendor ?? null,
      b.mtconnect_version ?? null,
      b.instance_id,
      b.probe_xml,
      now,
      now,
    ),
  );

  stmts.push(
    c.env.DB.prepare("DELETE FROM data_items WHERE device_uuid = ?").bind(
      b.device_uuid,
    ),
  );

  for (const di of b.data_items) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO data_items (device_uuid, data_item_id, category, type, sub_type, units, native_units, component_path)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        b.device_uuid,
        di.id,
        di.category,
        di.type,
        di.subType ?? null,
        di.units ?? null,
        di.nativeUnits ?? null,
        di.componentPath,
      ),
    );
  }

  await c.env.DB.batch(stmts);

  return c.json({ ok: true, device_uuid: b.device_uuid });
});
