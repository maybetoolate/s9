# API reference

The API is REST with JSON. Every response has the same shape, and every error carries a machine readable code and a
request id for support.

Base URL in development: `http://localhost:4100`.

## Authentication

Authentication is handled by a maintained authentication library (Better-Auth); FlowForge does not implement its own
password or session protocol.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/sign-up/email` | Create an account: `{ email, password, name }` |
| `POST /api/auth/sign-in/email` | Sign in: `{ email, password }` |
| `POST /api/auth/sign-out` | End the session |
| `GET /api/auth/get-session` | The current session |

The session is a `HttpOnly` cookie named `flowforge.session_token`. Every request below is authorized against the
workspace of the caller; hiding a control in the UI is not authorization.

## Conventions

- **Pagination**: `?page=1&pageSize=25` (max 100). The response is
  `{ data: [...], pagination: { page, pageSize, total, totalPages } }`.
- **Correlation id**: every response carries `X-Request-Id`. Send your own `X-Request-Id` to correlate with the logs.
- **Error envelope**:

  ```json
  {
    "error": {
      "code": "workflow_not_published",
      "message": "the workflow is draft",
      "details": [],
      "requestId": "5f3a…"
    }
  }
  ```

- **Roles**: `owner` (everything), `editor` (write, publish, retry), `viewer` (read only).

## Workflows

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/workflows` | Filters: `status`, `triggerType`, `search`, `page`, `pageSize` |
| `POST` | `/api/workflows` | `{ name, description?, triggerType, definition? }` |
| `GET` | `/api/workflows/:id` | The detail: draft, versions, webhook endpoint, schedule |
| `PATCH` | `/api/workflows/:id` | `{ name?, description? }` |
| `PUT` | `/api/workflows/:id/draft` | `{ definition, revision }` — optimistic concurrency, `409` on a stale revision |
| `POST` | `/api/workflows/:id/validate` | `{ valid, issues[] }` |
| `POST` | `/api/workflows/:id/publish` | Creates an immutable version |
| `POST` | `/api/workflows/:id/webhook/test-delivery` | Signs and sends a delivery to the endpoint, and returns the exact request |
| `POST` | `/api/workflows/:id/pause` | Stops new runs, in-flight runs finish |
| `POST` | `/api/workflows/:id/resume` | |
| `POST` | `/api/workflows/:id/archive` | Keeps the history and the versions |
| `POST` | `/api/workflows/:id/duplicate` | Copies the draft into a new workflow |
| `GET` | `/api/workflows/:id/versions` | The published snapshots |
| `GET` | `/api/workflow-versions/:id` | One snapshot |
| `POST` | `/api/workflows/:id/run` | Production run: `{ input, idempotencyKey? }` → `202` |
| `POST` | `/api/workflows/:id/test` | Test run against the draft: `{ input }` → `202` |

### The workflow definition

```jsonc
{
  "trigger": {
    "type": "webhook",              // webhook | schedule | manual
    "slug": "contact-form-endpoint",
    "requireSignature": true,
    "samplePayload": { "email": "ada@example.com" }
  },
  "steps": [
    {
      "key": "save_contact",        // lowercase slug, fixed at creation
      "name": "Save contact",
      "type": "database_insert",    // http_request | send_email | database_insert | notification
      "config": { "table": "contacts", "values": { "email": "{{trigger.body.email}}" } }
    }
  ],
  "policy": {
    "maxSteps": 10,
    "executionTimeoutMs": 600000,
    "concurrency": 1,
    "retry": { "maxAttempts": 3, "baseDelayMs": 5000, "maxDelayMs": 300000, "timeoutMs": 30000 }
  }
}
```

Schedule triggers use `{ "type": "schedule", "cron": "30 2 * * *", "timezone": "America/New_York", "catchUp": true }`.
Manual triggers use `{ "type": "manual", "samplePayload": {} }`.

### Variable mapping

One syntax, no expressions:

```
{{trigger.body.email}}
{{steps.save_contact.output.id}}
```

A path that cannot be resolved at publish time is a validation error. A value that is null at runtime is a permanent
step failure unless a default is configured. Steps are referenced by their stable key, never by their display name, and a
step may only reference an earlier step.

### Action configuration

| Action | Configuration |
| --- | --- |
| `http_request` | `method`, `url`, `headers`, `body`, `bodyType`, `timeoutMs`, `credentialId?`, `allowPrivateNetwork`, `idempotencyHeader?`, `executeForReal?` |
| `send_email` | `provider` (`resend` \| `mailpit`), `from`, `to`, `subject`, `body`, `credentialId?`, `idempotencyHeader?`, `executeForReal?` |
| `database_insert` | `table` (`contacts`), `values`, `dedupeKey?`, `executeForReal?` |
| `notification` | `channel`, `message`, `webhookUrl?`, `credentialId?`, `idempotencyHeader?`, `executeForReal?` |

## Webhook intake

```
POST /webhooks/:slug
```

This endpoint is public. It is the most security sensitive surface in the product.

**Headers**

| Header | Meaning |
| --- | --- |
| `X-FlowForge-Signature` | `t=<unix-ms>,v1=<hmac-hex>` — required when the endpoint requires a signature |
| `Idempotency-Key` | The deduplication key. `X-Event-Id` is accepted as an alternative. |

**Signature**

The signed payload is `<timestamp>.<raw body>` and the signature is the hex HMAC-SHA256 of that string, keyed with the
endpoint secret:

```bash
SECRET="whsec_…"
BODY='{"name":"Ada","email":"ada@example.com"}'
TS=$(date +%s000)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST "http://localhost:4100/webhooks/<slug>" \
  -H "content-type: application/json" \
  -H "idempotency-key: event-1" \
  -H "x-flowforge-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

The timestamp tolerance is five minutes. A rotated secret keeps working for a short overlap window, so a rotation does
not break senders that have not been updated yet.

### Getting the secret

The secret is shown exactly once, in the publish dialog, when the endpoint is
created. If you no longer have it:

- open the workflow, go to the **Webhook** tab and **rotate the signing secret** — the new secret is shown once;
- the previous secret keeps working for an hour, so a rotation does not break a sender that has not been updated.

The **Send a signed test delivery** button in the same tab signs a sample payload with the endpoint secret, delivers it
to the intake and shows the exact request it sent. It is the quickest way to see the signature format and to confirm
that the endpoint accepts a delivery. The delivery is real: the workflow runs its actions for real.

**Status codes**

| Code | Meaning |
| --- | --- |
| `202` | The event was accepted and durably stored. The execution id is in the body. |
| `200` | A duplicate delivery inside the deduplication window. The original execution id is returned and nothing was created. |
| `400` | The body is not a JSON object. |
| `401` | The signature is missing or invalid. Nothing was enqueued. |
| `404` | Unknown endpoint. |
| `409` | The workflow is paused, so the sender should retry later. |
| `413` | The body exceeds 256 KB. |
| `429` | The workflow is over its intake limit. The sender should retry later. |

The response returns as soon as the event is durably accepted, not after every workflow action has finished.

## Executions

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/executions` | Filters: `workflowId`, `status`, `triggerType`, `isTest`, `search`, `from`, `to` |
| `GET` | `/api/executions/:id` | The detail: steps, attempts, timeline, audit and the available recovery actions |
| `POST` | `/api/executions/:id/retry` | `{ stepKey, idempotencyKey }` — retries the step in place |
| `POST` | `/api/executions/:id/rerun` | `{ useCurrentVersion?, input? }` — creates a new execution |
| `POST` | `/api/executions/:id/cancel` | Queued runs, or the gap between steps |
| `POST` | `/api/executions/:id/steps/:stepKey/resolve` | `{ outcome: "succeeded" \| "failed", reason }` |

Retry and rerun requests take an idempotency key. Two simultaneous retry requests with the same key create one recovery,
not two.

## Schedules, actions, credentials and audit

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/schedules` | The derived schedule index |
| `POST` | `/api/schedules/:workflowId/enable` | |
| `POST` | `/api/schedules/:workflowId/disable` | |
| `GET` | `/api/actions` | The action registry: types, configuration schemas and examples |
| `POST` | `/api/actions/validate` | `{ type, config }` → `{ valid, issues[] }` |
| `GET` | `/api/credentials` | Never returns a secret |
| `POST` | `/api/credentials` | `{ name, provider, secret, metadata }` |
| `POST` | `/api/credentials/:id/rotate` | `{ secret }` |
| `DELETE` | `/api/credentials/:id` | `409 credential_in_use` when a published version still uses it |
| `GET` | `/api/audit` | Filters: `targetType`, `targetId` |
| `GET` | `/api/dashboard` | The summary cards, the recent runs and the runs that need attention |
| `GET` | `/api/me` | The user, the workspace and the role |

## Operations

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/health/ready` | Database and queue connectivity |
| `GET` | `/api/ops/queue` | Queue depth, outbox counters and the worker heartbeats |
| `GET` | `/api/ops/workspace-usage` | The active executions of the workspace |

## Limits

| Limit | Value |
| --- | --- |
| Steps per workflow | 10 |
| Webhook body | 256 KB |
| HTTP action response | 1 MB |
| Step timeout | 30 s default, 120 s maximum |
| Execution timeout | 10 minutes |
| Attempts | 3 by default, 5 maximum |
| Backoff | 5 s base, 5 min cap, with jitter |
| Webhook deduplication window | 24 hours |
| Signature timestamp tolerance | 5 minutes |
| Payload retention | 30 days |
| Concurrent runs per workflow | 1 by default |
| Queued runs per workflow | 1000, then `429` |
