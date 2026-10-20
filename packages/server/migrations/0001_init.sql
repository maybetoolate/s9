-- FlowForge initial schema.
--
-- Blueprint section 10 (data model blueprint) plus the "data model additions"
-- listed at the end of that section: WorkflowDraft, WebhookEndpoint,
-- RetryRequest, worker_id/lease_expires_at on StepExecution, trigger_event_id
-- and is_test on Execution, the canonical Schedule rules and the unique
-- constraints.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- workspaces

CREATE TABLE workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Identity comes from the auth provider (table `user`, created by the auth
-- migration). Memberships bind a user to a workspace and carry the role.
CREATE TABLE workspace_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id       text        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id);

-- ---------------------------------------------------------------- workflows

CREATE TABLE workflows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name              text        NOT NULL,
  description       text,
  status            text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'paused', 'archived')),
  trigger_type      text        NOT NULL CHECK (trigger_type IN ('webhook', 'schedule', 'manual')),
  current_version_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflows_workspace_idx ON workflows (workspace_id, updated_at DESC);
CREATE INDEX workflows_workspace_status_idx ON workflows (workspace_id, status);

-- Drafts live outside the immutable versions so editing never mutates a
-- published snapshot.
CREATE TABLE workflow_drafts (
  workflow_id  uuid PRIMARY KEY REFERENCES workflows (id) ON DELETE CASCADE,
  definition   jsonb       NOT NULL,
  revision     integer     NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid        NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version_number integer     NOT NULL,
  definition     jsonb       NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now(),
  published_by   text,
  UNIQUE (workflow_id, version_number)
);

ALTER TABLE workflows
  ADD CONSTRAINT workflows_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES workflow_versions (id) ON DELETE SET NULL;

CREATE INDEX workflow_versions_workflow_idx ON workflow_versions (workflow_id, version_number DESC);

-- -------------------------------------------------------------- credentials

CREATE TABLE credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name             text        NOT NULL,
  provider         text        NOT NULL,
  encrypted_secret jsonb       NOT NULL,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE INDEX credentials_workspace_idx ON credentials (workspace_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------- webhook endpoint

CREATE TABLE webhook_endpoints (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id               uuid        NOT NULL UNIQUE REFERENCES workflows (id) ON DELETE CASCADE,
  slug                      text        NOT NULL UNIQUE,
  secret_hash               text        NOT NULL,
  previous_secret_hash      text,
  previous_secret_expires_at timestamptz,
  rotated_at                timestamptz,
  require_signature         boolean     NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- schedule

CREATE TABLE schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id        uuid        NOT NULL UNIQUE REFERENCES workflows (id) ON DELETE CASCADE,
  timezone           text        NOT NULL DEFAULT 'UTC',
  schedule_spec      text        NOT NULL,
  enabled            boolean     NOT NULL DEFAULT true,
  next_run_at        timestamptz,
  last_occurrence_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;

-- The unique occurrence key prevents a second scheduler from creating the
-- same occurrence. `local_key` additionally de-duplicates the repeated local
-- hour on a daylight-saving fall-back day.
CREATE TABLE schedule_occurrences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   uuid        NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  local_key     text        NOT NULL,
  execution_id  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, scheduled_for),
  UNIQUE (schedule_id, local_key)
);

-- --------------------------------------------------------------- executions

CREATE TABLE executions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workflow_id          uuid        NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  workflow_version_id  uuid        NOT NULL REFERENCES workflow_versions (id),
  status               text        NOT NULL
                       CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
  trigger_type         text        NOT NULL,
  trigger_event_id     uuid,
  idempotency_key      text        NOT NULL,
  input                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  output               jsonb,
  error                jsonb,
  is_test              boolean     NOT NULL DEFAULT false,
  rerun_of_execution_id uuid       REFERENCES executions (id) ON DELETE SET NULL,
  worker_id            text,
  lease_token          uuid,
  lease_expires_at     timestamptz,
  run_sequence         integer     NOT NULL DEFAULT 0,
  queued_at            timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, idempotency_key)
);

CREATE INDEX executions_workspace_created_idx ON executions (workspace_id, created_at DESC);
CREATE INDEX executions_workflow_created_idx ON executions (workflow_id, created_at DESC);
CREATE INDEX executions_status_idx ON executions (workspace_id, status);
CREATE INDEX executions_lease_idx ON executions (status, lease_expires_at);
CREATE INDEX executions_rerun_idx ON executions (rerun_of_execution_id);

CREATE TABLE step_executions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      uuid        NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  step_key          text        NOT NULL,
  step_index        integer     NOT NULL,
  name              text        NOT NULL,
  type              text        NOT NULL,
  status            text        NOT NULL
                    CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'outcome_unknown')),
  input             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  output            jsonb,
  error             jsonb,
  resolved_manually boolean     NOT NULL DEFAULT false,
  resolution        jsonb,
  worker_id         text,
  lease_expires_at  timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_id, step_key)
);

CREATE INDEX step_executions_execution_idx ON step_executions (execution_id, step_index);

-- Attempt history is kept separate from the current step summary.
CREATE TABLE step_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_execution_id uuid      NOT NULL REFERENCES step_executions (id) ON DELETE CASCADE,
  attempt_number   integer     NOT NULL,
  status           text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out')),
  error            jsonb,
  idempotency_key  text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  duration_ms      integer,
  UNIQUE (step_execution_id, attempt_number)
);

-- ------------------------------------------------------------ trigger events

CREATE TABLE trigger_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid        NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  endpoint_id    uuid        REFERENCES webhook_endpoints (id) ON DELETE SET NULL,
  source_key     text,
  payload_digest text        NOT NULL,
  payload        jsonb,
  received_at    timestamptz NOT NULL DEFAULT now(),
  response       jsonb
);

-- Deduplication scope: per webhook endpoint plus idempotency key.
CREATE UNIQUE INDEX trigger_events_dedupe_idx
  ON trigger_events (endpoint_id, source_key)
  WHERE source_key IS NOT NULL;

-- ------------------------------------------------------------------ outbox

CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,
  event_type     text        NOT NULL,
  payload        jsonb       NOT NULL,
  status         text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'published', 'failed', 'dead_letter')),
  attempt_count  integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_pending_idx ON outbox_events (next_attempt_at) WHERE status IN ('pending', 'failed');

-- ------------------------------------------------------------ retry requests

CREATE TABLE retry_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id   uuid        NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  step_key       text        NOT NULL,
  idempotency_key text       NOT NULL UNIQUE,
  actor_id       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retry_requests_execution_idx ON retry_requests (execution_id);

-- ------------------------------------------------------------------- audit

CREATE TABLE audit_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  actor_id     text,
  actor_type   text        NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'system')),
  action       text        NOT NULL,
  target_type  text,
  target_id    text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_workspace_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_target_idx ON audit_events (target_type, target_id);

-- Audit events are append-only: the application role may not update or delete.
CREATE OR REPLACE FUNCTION audit_events_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_are_append_only();

-- --------------------------------------------------------------- operations

CREATE TABLE worker_heartbeats (
  worker_id           text PRIMARY KEY,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  current_execution_id uuid,
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- The demo database action writes into this FlowForge managed table only.
CREATE TABLE contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text,
  email      text,
  message    text,
  source     text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contacts_created_idx ON contacts (created_at DESC);
