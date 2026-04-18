import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine, testEnv } from "./helpers";

async function seedAlert(machineId: string, kind: string, cleared = false) {
  const now = new Date().toISOString();
  await testEnv()
    .DB.prepare(
      `INSERT INTO alerts (machine_id, kind, triggered_at, cleared_at, severity, message)
       VALUES (?, ?, ?, ?, 'warning', 'test')`,
    )
    .bind(machineId, kind, now, cleared ? now : null)
    .run();
}

describe("GET /alerts + POST /alerts/:id/ack", () => {
  beforeEach(async () => {
    await resetDb();
    await seedMachine("haas-vf2-1");
  });

  it("returns only open alerts by default", async () => {
    await seedAlert("haas-vf2-1", "feed_hold_extended");
    await seedAlert("haas-vf2-1", "idle_during_shift", true);
    const res = await SELF.fetch("https://x/alerts");
    const body = (await res.json()) as { alerts: Array<{ kind: string }> };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].kind).toBe("feed_hold_extended");
  });

  it("?include_cleared=1 returns all", async () => {
    await seedAlert("haas-vf2-1", "feed_hold_extended");
    await seedAlert("haas-vf2-1", "idle_during_shift", true);
    const res = await SELF.fetch("https://x/alerts?include_cleared=1");
    const body = (await res.json()) as { alerts: unknown[] };
    expect(body.alerts).toHaveLength(2);
  });

  it("acknowledges an alert", async () => {
    await seedAlert("haas-vf2-1", "feed_hold_extended");
    const alertRow = await testEnv()
      .DB.prepare("SELECT id FROM alerts LIMIT 1")
      .first<{ id: number }>();
    const res = await SELF.fetch(`https://x/alerts/${alertRow!.id}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "tyler" }),
    });
    expect(res.status).toBe(200);
    const after = await testEnv()
      .DB.prepare("SELECT acknowledged_by FROM alerts WHERE id = ?")
      .bind(alertRow!.id)
      .first<{ acknowledged_by: string }>();
    expect(after?.acknowledged_by).toBe("tyler");
  });
});
