import { env } from "cloudflare:test";
import type { Env } from "../src/types";

export function testEnv(): Env {
  return env as unknown as Env;
}

export async function resetDb(e: Env = testEnv()): Promise<void> {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM alerts"),
    e.DB.prepare("DELETE FROM rollups_shift"),
    e.DB.prepare("DELETE FROM rollups_minute"),
    e.DB.prepare("DELETE FROM events"),
    e.DB.prepare("DELETE FROM state_intervals"),
    e.DB.prepare("DELETE FROM machines"),
  ]);
}

export async function seedMachine(
  id: string,
  overrides: Partial<{
    display_name: string;
    controller_kind: string;
    pool: string;
    ip: string;
  }> = {},
  e: Env = testEnv(),
): Promise<void> {
  const now = new Date().toISOString();
  await e.DB.prepare(
    `INSERT INTO machines (id, display_name, controller_kind, pool, ip, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      overrides.display_name ?? id,
      overrides.controller_kind ?? "haas-ngc",
      overrides.pool ?? "small-3-axis-mill",
      overrides.ip ?? "10.0.50.21",
      now,
      now,
    )
    .run();
}

export function authHeaders(secret = "test-secret"): HeadersInit {
  return { "X-Edge-Secret": secret, "Content-Type": "application/json" };
}
