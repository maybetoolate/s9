# Architecture

FlowForge is a modular monolith API plus a separate worker process, with PostgreSQL as the durable system of record and
Redis/BullMQ as the delivery mechanism. Deployment stays simple; the module boundaries stay clear.

```
┌────────────┐        ┌──────────────────────────────────────────────┐
│  Browser   │        │  Next.js web app (packages/web)             │
│            │◀──────▶│  dashboard · builder · execution history     │
└────────────┘        └───────────────────────┬──────────────────────┘
                                                │ REST (JSON)
                                                ▼
                        ┌───────────────────────────────────────────────┐
   external sender ───▶│  Node.js API (packages/server)                │
   (webhook)           │  auth · CRUD · validation · publish · intake │
                        └───────┬───────────────────────────┬───────────┘
                                │ transaction              │ read
                                ▼                           ▼
   ┌────────────────────────────────────┐      ┌───────────────────────────┐
   │  PostgreSQL                        │◀────▶│  Worker                   │
   │  workflows · versions · drafts     │      │  claims · runs · persists │
   │  executions · steps · attempts     │      └───────────┬───────────────┘
   │  outbox · audit · trigger events   │                  │ claim
   │  schedules · credentials           │      ┌───────────▼───────────────┐
   └────────────────────────────────────┘      │  Redis + BullMQ          │
                ▲                               │  execution continuations │
                │                               └───────────────────────────┘
                │ durable publication
   ┌────────────┴───────────┐
   │  Outbox dispatcher      │  claims rows with FOR UPDATE SKIP LOCKED
   │  + stale-run reconciler │  re-enqueues lost work, recovers leases
   └────────────────────────┘

   ┌───────────────────────────────────────────────────────────────┐
   │  Scheduler process                                            │
   │  finds due schedule occurrences → creates deduplicated runs   │
   └───────────────────────────────────────────────────────────────┘
```

## Components

| Component | Responsibilities | Must not do |
| --- | --- | --- |
| Next.js web app | Workflow editor, dashboard, execution views | Execute workflow steps in the browser |
| Node.js API | Auth, CRUD, validation, publish, webhook intake, run requests | Perform long-running workflow work inline |
| PostgreSQL | Durable definitions, versions, executions, attempts, audit events | Rely on queue state as the only record |
| Redis + BullMQ | Deliver execution continuations, delayed retries, worker concurrency | Become the source of truth for business state |
| Worker | Load the pinned version, execute steps, persist state transitions | Trust arbitrary workflow input or skip state checks |
| Scheduler | Find due schedule occurrences, create deduplicated executions | Use only process memory to remember future runs |
| Action adapters | HTTP, email, database, notification | Assume every request is safe to repeat |

## The execution lifecycle

1. A trigger adapter authenticates and validates the event.
2. The API or the scheduler creates the execution **and** an outbox event in one PostgreSQL transaction.
3. The outbox dispatcher publishes the event to BullMQ. Publishing twice is harmless.
4. The worker claims the job, verifies the execution is still eligible, and installs a database lease.
5. The worker records the step start, performs the action with a deadline, and records the result.
6. A failure is classified as validation, permanent, transient, rate limited, timeout or infrastructure.
7. Retryable failures are scheduled with bounded exponential backoff and jitter. Exhausted or permanent failures move
   to a terminal failure state. A timeout on a side-effecting action becomes `outcome_unknown`.
8. When every step succeeded, the execution is marked successful and an audit event is written.

## Why an outbox?

A database write and a Redis enqueue are not one atomic transaction. If the database commits but the enqueue fails, the
execution would be stranded: the row says "queued" and nothing will ever pick it up.

The outbox stores the *intent* to enqueue in the same PostgreSQL transaction as the execution. The dispatcher claims rows
with `FOR UPDATE SKIP LOCKED`, publishes them to BullMQ and marks them published. A failed publish is retried with
backoff; after the maximum number of attempts the row becomes `dead_letter` and raises an alert instead of retrying
forever.

**Every** queue publication goes through the outbox — the initial run, a delayed retry and a re-enqueue after a crash.
There is exactly one code path that publishes work, which makes the failure modes easy to reason about.

## The claim protocol

```
worker                                   database
  │                                        │
  │  UPDATE executions                     │
  │  SET status='running',                 │
  │      lease_token = $1,                 │
  │      lease_expires_at = now()+lease    │
  │  WHERE id = $2                         │
  │    AND status IN ('queued','running',  │
  │           'retrying')                  │
  │    AND (lease_expires_at IS NULL       │
  │         OR lease_expires_at < now()     │
  │         OR lease_token = $1)           │
  │                                        │
  ├───────────────────────────────────────▶│  ← the claim
  │                                        │
  │  heartbeat every 30s:                  │
  │    UPDATE … lease_expires_at = now()+  │
  │    WHERE id AND lease_token AND        │
  │      status='running'                  │
  │                                        │
  │  every state change:                   │
  │    WHERE id AND status = ANY(from[])   │
  │      AND lease_token = $1              │
  │                                        │
  │  release:                              │
  │    SET lease_token = NULL              │
  └───────────────────────────────────────▶│
```

The lease duration is larger than the maximum step timeout plus a heartbeat margin (180 s against a 120 s maximum step
timeout). The database lease and the guarded transitions are authoritative; BullMQ's stalled-job detection is only a
secondary signal.

A duplicate queue delivery is harmless: the second worker either fails to claim (the lease is held) or finds a terminal
state and stops. It cannot produce an invalid transition.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| The API crashes before the commit | No execution was accepted. The sender may retry the webhook. |
| The database commits but the publish fails | The outbox dispatcher publishes later. |
| The queue delivers a duplicate job | The worker checks the persisted state and skips invalid transitions. |
| The worker crashes during an action | The lease expires and the reconciler marks the run for a controlled retry. |
| The provider answers 429 or a transient 5xx | Bounded exponential backoff with jitter, honouring `Retry-After`. |
| The provider answers a permanent 4xx | The run fails promptly with a sanitised, actionable error. |
| The scheduler restarts | Due occurrences are reconciled from the durable schedule records. |
| A workflow is edited after publication | Existing executions stay pinned to their original version. |
| A retry is requested twice | The retry-request idempotency key produces one recovery. |

## Recovery operations

| Operation | Effect | Side effects |
| --- | --- | --- |
| Retry step | The same execution moves from `failed` back to `queued`; only the failed step runs again | The steps that already succeeded are skipped |
| Rerun | A new execution is created, linked through `rerun_of_execution_id`, with a new idempotency key | Every step repeats, including the successful ones |
| Resolve an unknown outcome | The step is marked `succeeded` or `failed` manually, with a resolution record | The original attempt history is never edited |

## Data model

See [state-machines.md](state-machines.md) for the transitions and [the migrations](../packages/server/migrations) for
the authoritative schema.

| Entity | Purpose |
| --- | --- |
| `workspaces`, `workspace_memberships` | Ownership boundary for workflows and credentials |
| `workflows`, `workflow_drafts`, `workflow_versions` | Stable identity, an editable draft and immutable snapshots |
| `credentials` | Provider secrets, encrypted, separate from the definitions |
| `webhook_endpoints` | The intake URL, the signing secret and the rotation metadata |
| `schedules`, `schedule_occurrences` | The derived schedule index and the deduplicated occurrences |
| `executions`, `step_executions`, `step_attempts` | One run, the state of every step and the history of every attempt |
| `trigger_events` | The webhook receipt and the deduplication record |
| `outbox_events` | Reliable publication of queued work |
| `retry_requests` | Recovery requests, guarded by an idempotency key |
| `audit_events` | Append-only record of publish, pause, retry, rotation and other sensitive operations |

## Versioning

A draft is the editable working copy. Publishing creates an immutable `workflow_version` and points
`workflows.current_version_id` at it. An execution always pins exactly one version, so editing a workflow never changes
the behaviour of a run that is already in flight.

Test runs are the exception: they pin a draft revision and store the definition snapshot on the execution, because a
test must reproduce exactly what the operator was looking at.

## Schedules

The published trigger configuration is the source of truth. The `schedules` table is a derived index the scheduler polls.
Two unique constraints protect the occurrence:

- `(schedule_id, scheduled_for)` — the same instant cannot be created twice;
- `(schedule_id, local_key)` — the repeated local hour of a daylight-saving fall-back fires once, not twice.

The scheduler holds an advisory lock per schedule, so several pollers can run safely.

Occurrences are evaluated as *wall clock* times in the schedule's own timezone and then resolved to an instant:

- a local time that does not exist (spring forward) fires once, at the end of the gap — a 02:30 schedule fires at 03:00;
- a local time that happens twice (fall back) fires once, at its first occurrence;
- after downtime only the latest missed occurrence is caught up, and only when it is less than 24 hours old.
