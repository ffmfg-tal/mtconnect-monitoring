import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireEdgeSecret } from "../src/auth";
import type { Env } from "../src/types";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", requireEdgeSecret);
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
}

describe("requireEdgeSecret", () => {
  it("401s when no X-Edge-Secret header", async () => {
    const env = { EDGE_SHARED_SECRET: "correct-secret" } as Env;
    const res = await makeApp().fetch(
      new Request("http://test/protected"),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("401s on wrong secret", async () => {
    const env = { EDGE_SHARED_SECRET: "correct-secret" } as Env;
    const res = await makeApp().fetch(
      new Request("http://test/protected", {
        headers: { "X-Edge-Secret": "wrong" },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("passes with correct secret", async () => {
    const env = { EDGE_SHARED_SECRET: "correct-secret" } as Env;
    const res = await makeApp().fetch(
      new Request("http://test/protected", {
        headers: { "X-Edge-Secret": "correct-secret" },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("500s when server misconfigured (empty secret)", async () => {
    const env = { EDGE_SHARED_SECRET: "" } as Env;
    const res = await makeApp().fetch(
      new Request("http://test/protected", {
        headers: { "X-Edge-Secret": "anything" },
      }),
      env,
    );
    expect(res.status).toBe(500);
  });
});
