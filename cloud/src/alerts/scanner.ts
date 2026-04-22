import type { Env } from "../types";
import { scanAlerts, type AlertInput } from "./rules";
import { postToSlack } from "./slack";

export async function runAlertScanner(env: Env): Promise<void> {
  const nowUtc = new Date().toISOString();
  const devices = await env.DB.prepare(
    "SELECT device_uuid, name FROM devices",
  ).all<{ device_uuid: string; name: string }>();

  for (const d of devices.results) {
    await scanDevice(env, d.device_uuid, d.name, nowUtc);
  }
}

async function scanDevice(
  env: Env,
  deviceUuid: string,
  deviceName: string,
  nowUtc: string,
): Promise<void> {
  // Read state cursor JSON from processor_cursors.state_json for the
  // 'state_machine_state' pseudo-stream. This is the "currently open"
  // state interval inferred from the state machine.
  const stateRow = await env.DB.prepare(
    "SELECT state_json FROM processor_cursors WHERE device_uuid = ? AND stream = 'state_machine_state'",
  )
    .bind(deviceUuid)
    .first<{ state_json: string | null }>();
  const openIntervals: AlertInput["openIntervals"] = [];
  if (stateRow?.state_json) {
    try {
      const c = JSON.parse(stateRow.state_json);
      if (c.lastState && c.lastStateStart) {
        openIntervals.push({
          state: c.lastState,
          started_at: c.lastStateStart,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const openCondsRes = await env.DB.prepare(
    "SELECT data_item_id, level, started_at FROM conditions WHERE device_uuid = ? AND ended_at IS NULL",
  )
    .bind(deviceUuid)
    .all<{ data_item_id: string; level: string; started_at: string }>();
  const openConditions = openCondsRes.results.map((r) => ({
    data_item_id: r.data_item_id,
    level: r.level as "WARNING" | "FAULT" | "UNAVAILABLE",
    started_at: r.started_at,
  }));

  const latestObs = await env.DB.prepare(
    "SELECT MAX(timestamp_utc) AS ts FROM observations WHERE device_uuid = ?",
  )
    .bind(deviceUuid)
    .first<{ ts: string | null }>();

  const recentEstopRow = await env.DB.prepare(
    "SELECT 1 AS x FROM events WHERE device_uuid = ? AND kind = 'estop' AND ts > datetime('now','-60 seconds') LIMIT 1",
  )
    .bind(deviceUuid)
    .first<{ x: number }>();

  const alerts = scanAlerts({
    nowUtc,
    openIntervals,
    openConditions,
    latestObservationTs: latestObs?.ts ?? null,
    recentEstop: !!recentEstopRow,
  });

  for (const a of alerts) {
    const existing = await env.DB.prepare(
      "SELECT id FROM alerts WHERE device_uuid = ? AND kind = ? AND cleared_at IS NULL LIMIT 1",
    )
      .bind(deviceUuid, a.kind)
      .first<{ id: number }>();
    if (existing) continue; // already firing
    await env.DB.prepare(
      "INSERT INTO alerts (device_uuid, kind, severity, triggered_at, message) VALUES (?,?,?,?,?)",
    )
      .bind(deviceUuid, a.kind, a.severity, a.triggered_at, a.message)
      .run();
    await postToSlack(
      env.SLACK_WEBHOOK_URL,
      `[${a.severity.toUpperCase()}] ${deviceName}: ${a.message}`,
    );
  }

  // Auto-clear: if an alert was firing but the condition is no longer true, clear it.
  const openAlerts = await env.DB.prepare(
    "SELECT id, kind FROM alerts WHERE device_uuid = ? AND cleared_at IS NULL",
  )
    .bind(deviceUuid)
    .all<{ id: number; kind: string }>();
  const firingKinds: Set<string> = new Set(alerts.map((a) => a.kind));
  for (const oa of openAlerts.results) {
    if (!firingKinds.has(oa.kind)) {
      await env.DB.prepare("UPDATE alerts SET cleared_at = ? WHERE id = ?")
        .bind(nowUtc, oa.id)
        .run();
    }
  }
}
