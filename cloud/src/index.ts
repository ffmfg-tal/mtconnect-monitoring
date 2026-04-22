import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";
import { probeIngest } from "./ingest/probe";
import { observationsIngest } from "./ingest/observations";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.route("/probe", probeIngest);
ingest.route("/observations", observationsIngest);
app.route("/ingest", ingest);

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ) {
    // cron handlers wired in later tasks
  },
} satisfies ExportedHandler<Env>;
