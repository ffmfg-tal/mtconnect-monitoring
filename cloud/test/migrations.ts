// cloud/test/migrations.ts
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Env } from "../src/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function applyMigrations(env: Env): Promise<void> {
  const dir = join(__dirname, "..", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }
  }
}
