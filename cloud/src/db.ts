import type { Env } from "./types";

export async function machineExists(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS x FROM machines WHERE id = ? AND enabled = 1",
  )
    .bind(id)
    .first<{ x: number } | null>();
  return row !== null;
}

export async function distinctMachineIds(
  env: Env,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT id FROM machines WHERE enabled = 1 AND id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{ id: string }>();
  return new Set(res.results.map((r) => r.id));
}
