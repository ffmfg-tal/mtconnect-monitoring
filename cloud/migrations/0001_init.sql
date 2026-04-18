-- machines: static registry, one row per machine
CREATE TABLE machines (
  id                TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  controller_kind   TEXT NOT NULL,
  pool              TEXT,
  ip                TEXT,
  agent_device_uuid TEXT,
  fulcrum_equip_id  TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- state_intervals: closed intervals of Execution state
CREATE TABLE state_intervals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT NOT NULL,
  state             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT NOT NULL,
  duration_seconds  INTEGER NOT NULL,
  program           TEXT,
  tool_number       INTEGER,
  inferred_job_id   TEXT,
  inferred_op_id    TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_state_intervals_machine_time ON state_intervals(machine_id, started_at);

-- events: discrete occurrences
CREATE TABLE events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT NOT NULL,
  ts                TEXT NOT NULL,
  kind              TEXT NOT NULL,
  severity          TEXT NOT NULL,
  payload           TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_events_machine_time ON events(machine_id, ts);

-- rollups_minute
CREATE TABLE rollups_minute (
  machine_id            TEXT NOT NULL,
  minute_bucket         TEXT NOT NULL,
  active_seconds        INTEGER NOT NULL DEFAULT 0,
  feed_hold_seconds     INTEGER NOT NULL DEFAULT 0,
  stopped_seconds       INTEGER NOT NULL DEFAULT 0,
  interrupted_seconds   INTEGER NOT NULL DEFAULT 0,
  offline_seconds       INTEGER NOT NULL DEFAULT 0,
  spindle_rpm_avg       REAL,
  spindle_load_avg      REAL,
  spindle_load_max      REAL,
  feedrate_avg          REAL,
  feed_override_avg     REAL,
  part_count_delta      INTEGER NOT NULL DEFAULT 0,
  program               TEXT,
  tool_number           INTEGER,
  PRIMARY KEY (machine_id, minute_bucket)
);

-- rollups_shift
CREATE TABLE rollups_shift (
  machine_id        TEXT NOT NULL,
  shift_date        TEXT NOT NULL,
  shift_name        TEXT NOT NULL,
  scheduled_seconds INTEGER NOT NULL,
  active_seconds    INTEGER NOT NULL,
  feed_hold_seconds INTEGER NOT NULL,
  stopped_seconds   INTEGER NOT NULL,
  offline_seconds   INTEGER NOT NULL,
  availability      REAL NOT NULL,
  utilization       REAL NOT NULL,
  part_count        INTEGER NOT NULL DEFAULT 0,
  alarm_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, shift_date)
);

-- alerts
CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  triggered_at      TEXT NOT NULL,
  cleared_at        TEXT,
  severity          TEXT NOT NULL,
  message           TEXT NOT NULL,
  acknowledged_by   TEXT,
  acknowledged_at   TEXT
);
CREATE INDEX idx_alerts_machine_open ON alerts(machine_id, cleared_at);
CREATE INDEX idx_alerts_kind_open ON alerts(kind, machine_id, cleared_at);
