# ADR 0002 — BullMQ and Redis as the queue

**Status:** accepted

## Context

The worker needs delayed jobs (a retry after a backoff), bounded concurrency and a way to survive a restart without
losing the scheduled work.

## Decision

Use Redis with BullMQ. One BullMQ job per **execution continuation**, with the job id
`execution_id-run_sequence`.

A continuation runs the pending steps of an execution until it finishes, fails, or needs a delayed retry — which is
published as the next continuation with a delay.

The job id contains the run sequence, so a later re-enqueue is not deduplicated against a retained completed job. The
sequence is incremented in the same transaction that publishes the continuation.

BullMQ's own retry is used only for the *delivery* of a job (a worker crash), never for the business operation. The
workflow owns the retry policy; BullMQ's `attempts` is a safety net for a crashed worker.

The BullMQ lock duration is set above the maximum step timeout, but the **database lease is authoritative**: the
stalled-job detection is a secondary signal, and the reconciler is what actually recovers a stale run.

## Consequences

- Redis holds no business state. PostgreSQL is the system of record; losing Redis costs latency, not data. The
  reconciler re-enqueues the queued executions that were already published.
- The delayed retry is durable: the delay lives in the outbox row until the dispatcher publishes it.
- A queue delivery is at-least-once. The lease and the guarded transitions make that harmless for FlowForge state.
- BullMQ rejects a custom job id that contains a colon, so the separator is a dash. The shape
  (`<execution id><separator><run sequence>`) is unchanged from the blueprint.
- One Redis connection is enough for the MVP. Redis Cluster or a managed queue would be a later change.

## Alternatives considered

- **RabbitMQ.** A better broker, and one already running in this environment. It was rejected because the delayed-job
  and per-job-guard semantics we need are more awkward to build on top of it, and because the blueprint names
  BullMQ. Adding a broker without a proven need is the kind of operational surface the blueprint warns against.
- **Kafka.** Far too much for this scale.
- **PostgreSQL as the queue (`SELECT ... FOR UPDATE SKIP LOCKED`).** Attractive, because it removes a system. Rejected
  because a delayed retry would need a polling loop over the executions table, and because the worker would compete
  with the API for connections.
