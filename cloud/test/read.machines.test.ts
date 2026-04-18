import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { resetDb, seedMachine } from "./helpers";

describe("GET /machines", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns empty array when no machines", async () => {
    const res = await SELF.fetch("https://x/machines");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ machines: [] });
  });

  it("returns registered machines with current state", async () => {
    await seedMachine("haas-vf2-1", { display_name: "Haas VF-2 #1" });
    const res = await SELF.fetch("https://x/machines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      machines: Array<{ id: string; display_name: string; current_state: string | null }>;
    };
    expect(body.machines).toHaveLength(1);
    expect(body.machines[0].id).toBe("haas-vf2-1");
    expect(body.machines[0].display_name).toBe("Haas VF-2 #1");
    expect(body.machines[0].current_state).toBeNull();
  });
});
