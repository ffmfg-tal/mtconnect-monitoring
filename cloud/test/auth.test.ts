import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { authHeaders } from "./helpers";

describe("edge-secret auth middleware", () => {
  it("rejects missing header with 401", async () => {
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      body: JSON.stringify([]),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong secret with 401", async () => {
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      body: JSON.stringify([]),
      headers: authHeaders("bogus"),
    });
    expect(res.status).toBe(401);
  });

  it("allows correct secret through", async () => {
    const res = await SELF.fetch("https://x/ingest/state", {
      method: "POST",
      body: JSON.stringify([]),
      headers: authHeaders("test-secret"),
    });
    expect(res.status).toBe(200);
  });
});
