// cloud/test/migrations.ts
// Migrations are imported as raw text via Vite's ?raw suffix so that the
// applier works inside the vitest-pool-workers runtime, which does not
// implement node:fs readdirSync/readFileSync.
import type { Env } from "../src/types";
// @ts-expect-error — vite ?raw import returns string
import sql0001 from "../migrations/0001_v2_init.sql?raw";
// @ts-expect-error — vite ?raw import returns string
import sql0002 from "../migrations/0002_processor_cursor_state.sql?raw";

// Ordered list of migration contents. Add new migrations to the end.
const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: "0001_v2_init.sql", sql: sql0001 as string },
  { name: "0002_processor_cursor_state.sql", sql: sql0002 as string },
];

export async function applyMigrations(env: Env): Promise<void> {
  for (const m of MIGRATIONS) {
    // Strip full-line SQL comments so they don't confuse statement splitting
    // or cause whole statements to be filtered out.
    const stripped = m.sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = stripped
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }
  }
}
