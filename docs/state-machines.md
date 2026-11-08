# State machines

Allowed transitions are defined centrally in `packages/core/src/status.ts`. A transition that is not listed here is
rejected by the engine, and a terminal state is never overwritten by a late duplicate queue delivery.

## Execution

| From | To | Actor and guard | Audit |
| --- | --- | --- | --- |
| `queued` | `running` | The worker, after it acquired the lease | No |
| `queued` | `cancelled` | An editor | Required |
| `running` | `retrying` | The worker: a retryable error and attempts left | Attempt record |
| `running` | `succeeded` | The worker: every step succeeded | Yes |
| `running` | `failed` | The worker: a permanent error, exhausted attempts, or a step in `outcome_unknown` | Yes |
| `running` | `cancelled` | An editor, between steps | Required |
| `retrying` | `running` | The worker, on the next continuation | Attempt record |
| `retrying` | `failed` | The worker: the attempts were exhausted | Yes |
| `retrying` | `cancelled` | An editor | Required |
| `failed` | `queued` | An editor: a recovery operation with a retry-request idempotency key | Required |
| `succeeded` | — | Terminal | — |
| `cancelled` | — | Terminal | — |

```
                 ┌──────────┐
   trigger ────▶ │  queued  │
                 └────┬─────┘
                      │ worker claims the lease
                      ▼
   ┌──────────┐  retryable   ┌──────────┐
   │ running  │ ────────────▶ │ retrying │
   │          │ ◀──────────── │          │
   └────┬─────┘   next        └────┬─────┘
        │        continuation       │ attempts exhausted
        │ all steps succeeded      │ or permanent error
        ▼                          ▼
   ┌───────────┐             ┌──────────┐
   │ succeeded │             │  failed  │ ──▶ (recovery) ──▶ queued
   └───────────┘             └──────────┘
```

`cancelled` can be reached from `queued`, `running` and `retrying`. A running attempt is never interrupted: it
completes and is recorded, and the remaining steps are skipped. The central transition table also permits
`retrying → queued` and `queued → failed` for bookkeeping; the worker does not produce those edges.

## Step

| From | To | Actor and guard | Audit |
| --- | --- | --- | --- |
| `pending` | `running` | The worker, with a matching lease token | Attempt record |
| `pending` | `skipped` | The system: an earlier step failed permanently, or the execution was cancelled | No |
| `running` | `succeeded` | The worker | No |
| `running` | `failed` | The worker: a permanent error or the attempts were exhausted | No |
| `running` | `retrying` | The worker: a retryable error and attempts left | Attempt record |
| `running` | `outcome_unknown` | The worker: a timeout on an action that is not safe to repeat | Yes |
| `retrying` | `running` | The worker, on the next attempt | Attempt record |
| `failed` | `retrying` | An editor: a recovery operation | Required |
| `outcome_unknown` | `retrying` | An editor: a recovery operation | Required |
| `outcome_unknown` | `succeeded` | An editor: a manual resolution, stored as a resolution record | Required |
| `outcome_unknown` | `failed` | An editor: a manual resolution, stored as a resolution record | Required |
| `succeeded` | — | Terminal | — |
| `skipped` | — | Terminal | — |

```
   ┌─────────┐   ┌─────────┐   ┌───────────┐
   │ pending │──▶│ running │──▶│ succeeded │ (terminal)
   └────┬────┘   └────┬────┘   └───────────┘
        │             │  timeout on a side effect
        │ skipped     ▼
        │        ┌────────────────┐
        │        │ outcome_unknown│ ──▶ succeeded / failed (manual resolution)
        │        └────────────────┘
        │             │ permanent error
        ▼             ▼
   ┌─────────┐   ┌──────────┐
   │ skipped │   │  failed  │ ──▶ retrying (recovery operation)
   └─────────┘   └──────────┘
```

## Attempt

| From | To | Meaning |
| --- | --- | --- |
| `running` | `succeeded` | The action completed |
| `running` | `failed` | The action failed |
| `running` | `timed_out` | The deadline passed |

Attempt history is separate from the current step summary and is never edited — not even by a manual resolution.

## Workflow

| Status | Meaning | New production runs |
| --- | --- | --- |
| `draft` | The workflow is being edited | No |
| `published` | The workflow has an active version | Yes |
| `paused` | The workflow is temporarily stopped | No — the intake answers `409` |
| `archived` | The workflow is retired; the history and the versions are kept | No |

## Rules that always apply

- An execution with a step in `outcome_unknown` is moved to `failed` with a failure reason of `outcome_unknown`, so it
  appears in the recovery list.
- `cancelled` is an execution state only. The pending steps become `skipped`.
- Marking an `outcome_unknown` step as succeeded writes a resolution record (actor, reason, time) and sets the step to
  `succeeded` with `resolved_manually`. The original attempt stays recorded as `timed_out`.
- Skipped steps are retried only through the upstream failed step.
- Any change without a matching lease token is refused. This applies to system actors too, including the reconciler.

## Retry step vs. rerun

| Aspect | Retry step | Rerun |
| --- | --- | --- |
| Execution | The same execution | A new execution with `rerun_of_execution_id` |
| Workflow version | The same pinned version | The original version by default, the current one only on explicit choice |
| Idempotency | The same stable per-step keys | A new execution key, so it is not deduplicated against the original |
| Successful steps | Not repeated | All steps repeat, so the UI warns about the side effects |
| Typical use | A transient provider failure, or a resolved `outcome_unknown` | Corrected input, or a changed workflow |
