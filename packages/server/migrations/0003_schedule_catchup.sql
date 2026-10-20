-- Scheduler refinements.
--
-- The Schedule table is a derived index of the published trigger
-- configuration, so it mirrors the catch-up policy as well.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS catch_up boolean NOT NULL DEFAULT true;

-- The schedule index is queried by due time on every poll.
CREATE INDEX IF NOT EXISTS schedules_enabled_next_run_idx ON schedules (next_run_at) WHERE enabled;
