import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";
import { probeIngest } from "./ingest/probe";
import { observationsIngest } from "./ingest/observations";
import { runProcessor } from "./processor/run";
import { runAlertScanner } from "./alerts/scanner";
import { machinesRead } from "./read/machines";
import { utilizationRead } from "./read/utilization";
import { alertsRead } from "./read/alerts";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.route("/probe", probeIngest);
ingest.route("/observations", observationsIngest);
app.route("/ingest", ingest);
app.route("/machines", machinesRead);
app.route("/machines", utilizationRead);
app.route("/alerts", alertsRead);

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
