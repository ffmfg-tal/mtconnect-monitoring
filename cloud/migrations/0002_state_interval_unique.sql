CREATE UNIQUE INDEX uniq_state_intervals_dedup
  ON state_intervals(machine_id, started_at, state);
