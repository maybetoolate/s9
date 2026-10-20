# ADR 0001 — The transactional outbox

**Status:** accepted

## Context

An execution must be created in PostgreSQL and then published to a BullMQ queue. These are two separate systems, so
there is no transaction that spans them.

If the database commit succeeds and the Redis enqueue fails, the execution row says `queued` and nothing will ever pick
it up. The run is invisible: the operator sees a queued execution that never starts, and there is no record of why.

The same problem exists for every later publication: a delayed retry, a re-enqueue after a crash, a scheduled run.

## Decision

Every intent to publish work is written as an `outbox_events` row **in the same transaction** as the state change that
caused it. A dispatcher publishes the rows to BullMQ and marks them published.

```
transaction
  ├─ INSERT INTO executions ...
  └─ INSERT INTO outbox_events (event_type = 'execution.requested', payload = ...)
commit
        │
        ▼
  dispatcher: SELECT ... FOR UPDATE SKIP LOCKED → publish → UPDATE status = 'published'
```

All queue publications go through the outbox, so there is exactly one code path that publishes work.

## Consequences

- A crash between the commit and the publish cannot strand a run: the row is still pending and the dispatcher picks it
  up.
- Publishing twice is safe. The job id is `execution_id-run_sequence`, so BullMQ ignores the duplicate, and the
  database lease plus the guarded transitions make a duplicate delivery harmless.
- A publish that keeps failing becomes `dead_letter` after the maximum number of attempts and raises an alert instead of
  retrying forever.
- The outbox table grows. Published rows are deleted after the retention period (7 days by default).
- The dispatcher adds latency: a run starts one poll interval after the transaction commits. The interval is one second.

## Alternatives considered

- **Publish first, then write the database.** A crash between the two leaves a job for an execution that does not exist.
  The worker would have to tolerate that, which is exactly the kind of invisible failure this project is about.
- **A distributed transaction (two-phase commit).** Far more operational surface for a system that must stay small, and
  Redis is not a transactional participant anyway.
- **Polling the executions table for `queued` rows.** That turns the queue into a hint rather than a delivery
  mechanism, and it makes the "retry with a delay" case impossible without a separate scheduling store.
