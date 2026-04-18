import { Hono } from "hono";
import type { Env } from "./types";
import { requireEdgeSecret } from "./auth";
import { stateIngest } from "./ingest/state";
import { eventsIngest } from "./ingest/events";
import { rollupsIngest } from "./ingest/rollups";
import { machinesRead } from "./read/machines";
import { oeeRead } from "./read/oee";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "mtconnect-collector" }));

const ingest = new Hono<{ Bindings: Env }>();
ingest.use("*", requireEdgeSecret);
ingest.route("/state", stateIngest);
ingest.route("/events", eventsIngest);
ingest.route("/rollups", rollupsIngest);
app.route("/ingest", ingest);

app.route("/machines", machinesRead);
app.route("/machines", oeeRead);

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // cron handlers wired in later tasks
  },
} satisfies ExportedHandler<Env>;
