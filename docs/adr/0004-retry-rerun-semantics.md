# ADR 0004 — Retry, rerun and the unknown outcome

**Status:** accepted

## Context

A step fails. The operator wants it to run again. The obvious implementation — re-run the whole workflow — repeats the
side effects of the steps that already succeeded, which for an email or a payment is not acceptable.

At the same time, a timeout is not a failure: the provider may have completed the operation and lost the response.
Retrying it blindly can duplicate the side effect.

## Decision

Three distinct recovery operations, each with its own semantics.

### Retry step

Continues **the same execution**: it moves from `failed` back to `queued` and only the failed step runs again. The
steps that already succeeded keep their `succeeded` status and are skipped.

The request carries a **retry-request idempotency key**. The key is inserted into `retry_requests` with a unique
constraint, so two simultaneous requests create one recovery. The insert happens *before* the state checks, so the
second request is recognised as a duplicate instead of a conflict.

### Rerun

Creates a **new execution** linked through `rerun_of_execution_id`, with a new idempotency key (reusing the old one
would deduplicate the rerun against itself). Every step repeats, including the successful ones, so the UI warns about
the repeated side effects before the request is sent.

### The unknown outcome

A timeout on an action that is **not safe to repeat** does not become a retry. The step is marked `outcome_unknown` and
the execution is marked `failed` with the reason `outcome_unknown`, so it appears in the recovery list.

The operator then chooses explicitly:

- **retry** — the action may have to run again;
- **mark as succeeded** — after verifying the remote system. The decision is stored as a resolution record with the
  actor, the reason and the time, and the step is marked `resolved_manually`. The original attempt stays recorded as
  `timed_out`;
- **mark as failed**.

The attempt history is never edited, not even by a resolution.

## Consequences

- Retrying a failed step is safe with respect to the steps that already succeeded.
- The cost of a rerun is the operator's explicit decision, and the UI says so.
- The uncertainty of a timeout is visible rather than hidden behind a retry.
- Every recovery is audited, and the audit event records who asked for it.
- A failed step that *is* safe to repeat (the database insert with a business key) is retried automatically, like any
  other transient failure.

## Alternatives considered

- **Always rerun the whole workflow.** The simplest possible implementation, and the one that causes duplicate side
  effects. Rejected.
- **Compensation steps.** The right answer for a saga, and far beyond the MVP. A future addition, not a substitute for
  the distinction above.
- **Retry a timeout automatically.** Convenient, and exactly the failure mode this product exists to avoid.
