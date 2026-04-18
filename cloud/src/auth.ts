import type { MiddlewareHandler } from "hono";
import type { Env } from "./types";

export const requireEdgeSecret: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const provided = c.req.header("X-Edge-Secret");
  const expected = c.env.EDGE_SHARED_SECRET;
  if (!expected) {
    return c.json({ error: "server misconfigured" }, 500);
  }
  if (!provided || !timingSafeEqual(provided, expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
