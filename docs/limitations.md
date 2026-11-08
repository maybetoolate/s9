# Limitations

What s9 deliberately does **not** do, and why. Everything here is a scope decision from the blueprint, not an
oversight.

## Execution semantics

### Side effects are at-least-once, never exactly-once

A job may be delivered more than once, so an external system can see a repeated request. s9 cannot prevent this:
a provider that receives a request and then loses the response cannot be distinguished from a provider that never
received it.

What s9 does instead:

- every side-effecting step carries a **stable idempotency key**, so a provider that supports one can collapse the
  repeat;
- the database write action uses an **idempotent upsert** on a business key;
- a timeout on an action that is not safe to repeat becomes **`outcome_unknown`** instead of an automatic retry;
- the attempt history records every attempt, including the ones that failed.

The system never claims exactly-once side effects.

### A timeout is not a failure

A timeout proves that *no answer arrived*, not that the operation failed. Retrying a non-idempotent action blindly is
how duplicate charges happen. s9 surfaces the uncertainty and asks the operator.

### A duplicate delivery is harmless for s9 state, not for the provider

The lease and the guarded transitions make a duplicate queue delivery harmless to the database. They cannot stop an
external system from seeing a repeated request after a crash.

## Scope

Out of scope for the MVP, on purpose:

- **Branching, loops, parallel fan-out/fan-in, sub-workflows and human approval steps.** The builder is a linear
  ordered list. Every run is a straight line, which is what makes the history readable.
- **A general graph editor.** React Flow was evaluated and deferred: the model has to be stable before the canvas is
  worth building.
- **A plugin marketplace, OAuth app installs, dozens of vendor integrations.** Four action types are enough to prove the
  execution semantics.
- **Arbitrary user code.** No JavaScript, no shell. A workflow definition is a declarative document, not a program.
- **Distributed execution across regions.** One region, one durable store.
- **Real-time multi-user editing.** The draft uses optimistic concurrency (a revision), not operational transformation.

## Product limits

| Limit | Value |
| --- | --- |
| Steps per workflow | 10 |
| Webhook body | 256 KB |
| HTTP action response | 1 MB |
| Step timeout | 30 s default, 120 s maximum |
| Execution timeout | 10 minutes of active run time |
| Attempts per step | 3 by default, 5 maximum |
| Webhook deduplication window | 24 hours |
| Payload retention | 30 days declared; the cleanup job is not implemented |
| Concurrent runs per workflow | 1 by default |
| Queued runs per workflow | 1000, then the intake answers `429` |

The **Delay** action is not implemented. The blueprint lists it as a later addition; a delay would be a persisted
continuation rather than a worker that sleeps.

The **execution timeout** measures active run time. A persisted continuation (the future delay action) would not count
against it, and the total elapsed time would be capped separately.

## Roles and tenancy

The MVP exposes **one workspace per user** with three roles: `owner`, `editor` and `viewer`. Every query still carries
the workspace id, so the model is ready for more workspaces, but there is no workspace switcher, no invitations and no
per-workspace quota. Enterprise multi-tenancy is not built.

The **audience** is a technical operator, developer or small-team administrator who understands the business process and
wants to configure routine automations without building a bespoke backend path for each one.

## Not implemented from the production checklist

The blueprint's production readiness checklist is aspirational for this MVP. These items are **not** implemented:

- TLS termination at the ingress (expected from the platform or a reverse proxy);
- database backups with a tested restore procedure;
- worker concurrency and per-workspace rate limits beyond the workflow level cap;
- a secret rotation *procedure* (the rotation mechanism exists, the runbook does not);
- error reporting and alerting integrations (the counters and the alert thresholds are documented, the integrations
  are not);
- retention cleanup jobs for the execution details (the outbox is pruned; the execution payloads are not yet).

## Technical deviations from the blueprint

| Blueprint | What was built | Why |
| --- | --- | --- |
| `jobId` is `execution_id:run_sequence` | `execution_id-run_sequence` | BullMQ rejects a custom job id that contains a colon. The shape is unchanged. |
| The endpoint stores `secret_hash` | The endpoint stores the hash **and** the encrypted secret | The server has to recompute the HMAC to verify a signature, which a hash alone cannot do. |
| The trigger adapter validates the payload against a schema | The payload must be a JSON object of at most 256 KB | There is no JSON schema in the trigger configuration; adding one is a scope decision, not a technical limit. |
| The user model is owned by s9 | The identity tables are owned by the authentication library | The blueprint says to use a maintained authentication solution rather than inventing a protocol. |
