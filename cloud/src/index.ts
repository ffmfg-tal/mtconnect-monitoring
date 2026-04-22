import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";
import { probeIngest } from "./ingest/probe";
import { observationsIngest } from "./ingest/observations";
import { runProcessor } from "./processor/run";
import { runAlertScanner } from "./alerts/scanner";

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
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    if (controller.cron === "*/1 * * * *") {
      await runProcessor(env);
      await runAlertScanner(env);
    }
  },
} satisfies ExportedHandler<Env>;
