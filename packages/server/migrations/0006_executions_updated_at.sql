-- The executions table needs an updated_at column: every state change stamps
-- it, which makes the execution history easy to reason about and to query.

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS executions_updated_at_idx ON executions (workspace_id, updated_at DESC);
