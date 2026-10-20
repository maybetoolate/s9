# ADR 0003 — Immutable workflow versions

**Status:** accepted

## Context

An operator edits a workflow while runs are in flight. If a run read the definition when it started, the behaviour of
that run would change under its feet, and a failure could not be reproduced.

## Decision

A workflow has two things:

- a **draft** (`workflow_drafts`) — the editable working copy, with a revision for optimistic concurrency;
- **published versions** (`workflow_versions`) — immutable snapshots, numbered per workflow.

Publishing creates a new version and points `workflows.current_version_id` at it. An execution always pins exactly one
`workflow_version_id`, so a run keeps the behaviour it started with, no matter what happens to the workflow afterwards.

The **webhook endpoint** binds to the workflow, not to a version, so the intake URL survives a republish. Changing the
trigger settings does require a new version; rotating the signing secret does not.

**Test runs** are the exception: they pin a draft revision and store the definition snapshot on the execution, because
a test must reproduce exactly what the operator was looking at.

## Consequences

- A published workflow cannot be edited. The UI shows a "published with unpublished changes" indicator when the draft
  differs from the current version.
- The version history is a real audit trail: "which definition ran this execution?" is answerable forever.
- Editing the draft uses optimistic concurrency: the client sends the revision it loaded and a stale revision is
  rejected with `409` instead of silently overwriting another editor's work.
- The storage cost is one row per publication. Fine for this scale.
- The schedule configuration lives in the published definition; the `schedules` table is a derived index. The two must
  be kept in sync when a schedule trigger is published, which the publish transaction does.

## Alternatives considered

- **Edit the definition in place.** Simpler, and it makes every historical run ambiguous. Rejected.
- **Version the draft only on demand.** Same as the decision, but it makes "what did version 3 contain?" unanswerable.
- **Store the definition on the execution instead of a version reference.** That works, but it duplicates a large
  document per run and loses the ability to say "this run used version 3".
