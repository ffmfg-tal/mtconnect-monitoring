-- 0001_v2_init.sql — MTConnect v2 schema, raw-observation-centric

CREATE TABLE devices (
  device_uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  controller_type TEXT,
  controller_vendor TEXT,
  mtconnect_version TEXT,
  current_instance_id TEXT,
  probe_xml TEXT,
  probe_fetched_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE data_items (
  device_uuid TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  sub_type TEXT,
  units TEXT,
  native_units TEXT,
  component_path TEXT,
  PRIMARY KEY (device_uuid, data_item_id)
);

CREATE TABLE observations (
  device_uuid TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp_utc TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  value_num REAL,
  value_str TEXT,
  condition_level TEXT,
  condition_native_code TEXT,
  condition_severity TEXT,
  condition_qualifier TEXT,
  PRIMARY KEY (device_uuid, sequence)
);
CREATE INDEX idx_observations_ts ON observations(device_uuid, timestamp_utc);
CREATE INDEX idx_observations_type ON observations(device_uuid, data_item_id, timestamp_utc);

CREATE TABLE state_intervals (
  device_uuid TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  state TEXT NOT NULL,
  program TEXT,
  tool_number TEXT,
  controller_mode TEXT,
  PRIMARY KEY (device_uuid, started_at)
);

CREATE TABLE conditions (
  device_uuid TEXT NOT NULL,
  data_item_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  level TEXT NOT NULL,
  native_code TEXT,
  severity TEXT,
  qualifier TEXT,
  message TEXT,
  PRIMARY KEY (device_uuid, data_item_id, started_at)
);

CREATE TABLE events (
  device_uuid TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (device_uuid, ts, kind)
);

CREATE TABLE rollups_minute (
  device_uuid TEXT NOT NULL,
  minute_start TEXT NOT NULL,
  active_s REAL DEFAULT 0,
  feed_hold_s REAL DEFAULT 0,
  stopped_s REAL DEFAULT 0,
  interrupted_s REAL DEFAULT 0,
  ready_s REAL DEFAULT 0,
  offline_s REAL DEFAULT 0,
  part_delta INTEGER DEFAULT 0,
  program TEXT,
  tool_number TEXT,
  avg_spindle_rpm REAL,
  max_spindle_load REAL,
  avg_feedrate REAL,
  PRIMARY KEY (device_uuid, minute_start)
);

CREATE TABLE rollups_shift (
  device_uuid TEXT NOT NULL,
  shift_date TEXT NOT NULL,
  availability_pct REAL,
  utilization_pct REAL,
  part_count INTEGER,
  alarm_count INTEGER,
  scheduled_seconds INTEGER,
  PRIMARY KEY (device_uuid, shift_date)
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_uuid TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  cleared_at TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  message TEXT
);
CREATE INDEX idx_alerts_open ON alerts(device_uuid, cleared_at);

CREATE TABLE processor_cursors (
  device_uuid TEXT NOT NULL,
  stream TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  last_run_at TEXT,
  PRIMARY KEY (device_uuid, stream)
);
