import type { Env } from "../types";

const SCHEDULED_SECONDS_DEFAULT = 8 * 3600;

export async function computeShiftRollup(
  env: Env,
  date: string,
): Promise<void> {
  const from = `${date}T00:00:00Z`;
  const to = `${date}T23:59:59Z`;

  const devices = await env.DB.prepare(
    "SELECT device_uuid FROM devices",
  ).all<{ device_uuid: string }>();

  for (const d of devices.results) {
    const r = await env.DB.prepare(
      `SELECT
         COALESCE(SUM(active_s), 0) AS active_s,
         COALESCE(SUM(feed_hold_s), 0) AS feed_hold_s,
         COALESCE(SUM(part_delta), 0) AS part_count
       FROM rollups_minute
       WHERE device_uuid = ?
         AND datetime(minute_start) >= datetime(?)
         AND datetime(minute_start) <= datetime(?)`,
    )
      .bind(d.device_uuid, from, to)
      .first<{ active_s: number; feed_hold_s: number; part_count: number }>();

    const alarms = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM alerts
       WHERE device_uuid = ? AND severity = 'fault'
         AND datetime(triggered_at) >= datetime(?)
         AND datetime(triggered_at) <= datetime(?)`,
    )
      .bind(d.device_uuid, from, to)
      .first<{ count: number }>();

    const active = r?.active_s ?? 0;
    const feedHold = r?.feed_hold_s ?? 0;
    const utilization = active / SCHEDULED_SECONDS_DEFAULT;
    const availability = (active + feedHold) / SCHEDULED_SECONDS_DEFAULT;

    await env.DB.prepare(
      `INSERT INTO rollups_shift (device_uuid, shift_date, availability_pct, utilization_pct, part_count, alarm_count, scheduled_seconds)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (device_uuid, shift_date) DO UPDATE SET
         availability_pct = excluded.availability_pct,
         utilization_pct = excluded.utilization_pct,
         part_count = excluded.part_count,
         alarm_count = excluded.alarm_count,
         scheduled_seconds = excluded.scheduled_seconds`,
    )
      .bind(
        d.device_uuid,
        date,
        availability,
        utilization,
        r?.part_count ?? 0,
        alarms?.count ?? 0,
        SCHEDULED_SECONDS_DEFAULT,
      )
      .run();
  }
}
