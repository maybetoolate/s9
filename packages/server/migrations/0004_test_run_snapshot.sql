-- Test runs pin a draft revision.
--
-- A test run executes a snapshot of the draft, not a published version, so
-- the execution stores the pinned definition itself. The published version
-- reference stays for production runs.

ALTER TABLE executions
  ALTER COLUMN workflow_version_id DROP NOT NULL;

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS definition_snapshot jsonb;

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS draft_revision integer;

-- A production execution always pins a published version.
CREATE INDEX IF NOT EXISTS executions_version_idx ON executions (workflow_version_id)
  WHERE workflow_version_id IS NOT NULL;
