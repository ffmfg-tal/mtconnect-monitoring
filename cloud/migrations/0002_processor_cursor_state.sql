-- 0002_processor_cursor_state.sql — add JSON state column to processor_cursors
-- for storing the state-machine and event-detector cursors as JSON blobs.
-- The plan originally tried to cram JSON into last_sequence (an INTEGER),
-- which obviously fails. We add a dedicated TEXT column instead.

ALTER TABLE processor_cursors ADD COLUMN state_json TEXT
