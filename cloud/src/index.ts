import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.post("/state", (c) => c.json({ inserted: 0 }));
app.route("/ingest", ingest);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // cron handlers wired in later tasks
  },
} satisfies ExportedHandler<Env>;
