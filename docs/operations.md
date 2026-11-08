# Operations guide

## Local development

```bash
docker compose up -d postgres redis mailpit sink   # infrastructure
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev                                            # api (auth included), worker, scheduler, web
```

| Service | URL |
| --- | --- |
| Web app | <http://localhost:3000> |
| API (authentication included) | <http://localhost:4100> |
| Mail catcher | <http://localhost:8025> |
| Demo sink | <http://localhost:8081> |
| PostgreSQL | `localhost:55432` |
| Redis | `localhost:56379` |

Sign in with `operator@s9.local` / `s9-demo-password`.

### Runtime

The API is a Hono application and, like the worker and scheduler, runs on both Bun and Node.js. Bun is the default.
To run the compiled output on Node.js, build the server and use the `:node` scripts:

```bash
pnpm --filter @s9/server build
pnpm --filter @s9/server start:api:node
pnpm --filter @s9/server start:worker:node
pnpm --filter @s9/server start:scheduler:node
```

`RUNTIME=node ./scripts/start-local.sh` starts the same processes from `dist` on Node.js. Compose accepts
`RUNTIME_IMAGE` and `RUNTIME_BIN` build arguments/commands, so
`RUNTIME_IMAGE=node:22-alpine RUNTIME_BIN=node docker compose up --build -d` builds Node.js images.

### Useful scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the API (with embedded auth), the worker, the scheduler and the web app |
| `pnpm db:generate` | Generate a new SQL migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply the pending migrations |
| `pnpm db:seed` | Create the demo workspace, the operator and the demo workflow |
| `docker compose exec api bun packages/server/dist/cli-seed.js` | The same, inside the container network |
| `pnpm db:reset` | Drop and recreate the `public` and `drizzle` schemas |
| `pnpm test` | The unit and integration suites |
| `pnpm typecheck` | Typecheck every package |
| `./scripts/start-local.sh` | Start only the backend processes (useful for a manual verification run) |
| `./scripts/verify-local.sh` | End-to-end check: sign in, publish, signed webhook, duplicate, bad signature, execution result |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `REDIS_URL` | — | Redis connection string (required) |
| `API_PORT` | `4100` | The port the API listens on |
| `API_PUBLIC_URL` | `http://localhost:4100` | Used to build the webhook URLs |
| `API_INTERNAL_URL` | — | The web app's server-to-server address for the API (Compose: `http://api:4000`) |
| `API_SELF_URL` | loopback on `API_PORT` | Address the API uses to deliver to its own webhook intake |
| `WEB_PUBLIC_URL` | `http://localhost:3000` | The origin of the web app (the auth cookie origin) |
| `SESSION_SECRET` | — | The Better-Auth session signing secret, at least 16 characters (required) |
| `ENCRYPTION_KEY` | — | Base64 encoded 32 byte master key (required) |
| `ENCRYPTION_KEY_ID` | `key-1` | The key id stored beside each ciphertext |
| `WORKER_ID` | `worker-1` | The identifier of this worker |
| `WORKER_CONCURRENCY` | `5` | The number of continuations a worker runs at once |
| `EMAIL_PROVIDER` | `mailpit` | `resend` or the local catcher |
| `MAILPIT_URL` | `http://localhost:8025` | The local mail catcher |
| `RESEND_API_KEY` | — | Required for the `resend` provider |
| `ALLOWED_PRIVATE_HOSTS` | — | Comma separated hostnames that may resolve to a private address |
| `DEMO_NOTIFICATION_URL` | `http://localhost:8081/notify` | The destination of the demo workflow's notification step |

Generate the secrets:

```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -hex 32      # SESSION_SECRET
```

## Troubleshooting

### An execution stays `queued`

The worker never claimed it. Check that the worker process is running and that the outbox was published:

```sql
SELECT status, count(*) FROM outbox_events GROUP BY status;
SELECT event_type, status, attempt_count, last_error FROM outbox_events
 WHERE status IN ('failed','dead_letter') ORDER BY created_at DESC LIMIT 10;
```

A row in `dead_letter` means the publish failed repeatedly: the message is not on the queue and the execution will never
start. Inspect `last_error`, fix the cause and re-enqueue the execution from the UI.

### An execution stays `running`

The lease expired, which means the worker died. The reconciler re-enqueues it within 15 seconds. If it does not:

```sql
SELECT id, status, worker_id, lease_expires_at FROM executions
 WHERE status IN ('running','retrying') ORDER BY updated_at DESC;
```

### Redis lost its data

Nothing is lost: the reconciler re-enqueues the queued executions that have no pending outbox row.

```sql
SELECT count(*) FROM executions WHERE status = 'queued';
```

Wait for the reconciler (15 s) or restart the worker, which re-enqueues immediately.

### The queue is stuck

```bash
docker compose exec redis redis-cli -n 0 keys 'bull:s9-executions:*'
curl -s http://localhost:4100/api/ops/queue   # needs a session
```

The queue counters show the waiting, active, delayed and failed jobs, the outbox counters and the worker heartbeats. A
worker that has not sent a heartbeat for more than a minute is dead.

### The web app cannot reach the API

The web app proxies every `/api/*` request to the API. If the proxy cannot connect, the API address is wrong for the
environment it runs in:

```bash
docker compose exec web printenv API_INTERNAL_URL API_PUBLIC_URL
```

Inside the compose network the internal address is `http://api:4000`; on the host it is `http://localhost:4100`. The
address is read at runtime, so changing it only needs a restart of the web container, not a rebuild.

### The session does not persist in the browser

The session cookie is marked `Secure` only when `WEB_PUBLIC_URL` is an `https://` URL. A browser silently drops a
`Secure` cookie on a plain HTTP origin, so a local deployment over HTTP has to keep `WEB_PUBLIC_URL` on `http://`.

### The API refuses to start on an existing database

The Drizzle baseline is a complete schema, not an incremental migration, so a database created by the previous
migration runner cannot be adopted in place. The runner detects it (`public.workspaces` or `public.schema_migrations`
without Drizzle history) and stops with an actionable message instead of a confusing "relation already exists" error.
Recreate the development database once:

```bash
pnpm db:reset && pnpm db:migrate && pnpm db:seed
```

This destroys the data in that database. Back it up first if it contains anything you need.

### The demo workflow fails on the notification step

The demo workflow stores `DEMO_NOTIFICATION_URL` in its definition, so the value has to be reachable **from the
worker**. Run the seed in the same environment as the worker: on the host it is `http://localhost:8081/notify`, inside
the compose network it is `http://sink:8080/notify`. The seed warns when the destination is not reachable.

### A webhook returns 401

The signature does not match. The signed payload is `<timestamp>.<raw body>` — the exact bytes that were sent, not the
re-serialised JSON. The timestamp is in milliseconds and the tolerance is five minutes. After a rotation the previous
secret stays valid for one hour.

### How do I sign a webhook request?

The signature is computed by the **sender**; s9 never hands it out. The sender holds the endpoint secret and
signs the request:

```
signature = HMAC_SHA256(secret, "<timestamp>.<raw body>")
```

The timestamp is unix milliseconds, the signed payload is the timestamp, a dot and the **exact bytes of the body**, and
the hex digest is sent as `X-S9-Signature: t=<ts>,v1=<hex>`. The timestamp tolerance is five minutes.

```bash
SECRET="whsec_..."
BODY='{"name":"Ada","email":"ada@example.com"}'
TS=$(date +%s000)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST "$WEBHOOK_URL" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -H "x-s9-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

Sign the bytes you actually send. Re-serialising the JSON produces a different body, and therefore a different
signature.

To see the exact request without building it yourself, use **Send a signed test delivery** in the workflow's Webhook
tab.

### A webhook returns 409

The workflow is paused. Pausing stops the creation of new production runs; the sender should retry later.

### A webhook returns 429

The workflow is over its queued execution limit. Reduce the load or raise `LIMITS.maxQueuedExecutionsPerWorkflow`.

### An HTTP action fails with "the destination resolves only to blocked addresses"

The SSRF protection rejected the destination. Either use a public address, set `allowPrivateNetwork` on the step
(the internal service is reachable on purpose), or add the hostname to `ALLOWED_PRIVATE_HOSTS` for the deployment.

### The email action fails

Check that the mail catcher is running and that `MAILPIT_URL` points at it. The captured messages are listed at
<http://localhost:8025>.

## Database operations

```bash
pnpm db:reset     # drop and recreate the schema (destroys everything)
pnpm db:migrate   # apply the pending migrations
pnpm db:seed      # demo workspace, operator and workflow
```

The schema is declared in `packages/server/src/db/schema.ts`. Drizzle Kit generates the SQL files in
`packages/server/migrations` from it, and the migration runner applies them under an advisory lock, recording the
history in `drizzle.__drizzle_migrations`. Applying them to an empty database is part of the CI contract. `pnpm
db:reset` drops both `public` and `drizzle` so a reset really starts from the baseline.

### Retention

- Published outbox rows are deleted after 7 days by the scheduler (`LIMITS.outboxRetentionDays`; the window is a
  constant, not a runtime setting).
- Execution payload retention is declared as 30 days (`LIMITS.payloadRetentionDays`), but no cleanup job is implemented
  yet. See [limitations.md](limitations.md).

### Backups

`pg_dump` is enough for a development deployment:

```bash
docker compose exec postgres pg_dump -U s9 s9 > s9-$(date +%F).sql
```

Restore with `psql`. A production deployment needs a tested restore procedure — see the production checklist in the
blueprint.

## Metrics and alerts

The structured logs carry the request id, workspace id, workflow id, execution id, step key and attempt number, so the
counters can be derived from them:

| Metric | Source |
| --- | --- |
| `s9_executions_total` by status | The `executions` table |
| `s9_step_duration_seconds` | `step_attempts.duration_ms` |
| `s9_queue_depth` | `GET /api/ops/queue` |
| `s9_outbox_lag_seconds` | The age of the oldest pending outbox row |
| `s9_worker_heartbeat_age_seconds` | `worker_heartbeats.last_seen_at` |

Suggested starting alerts:

| Alert | Threshold |
| --- | --- |
| Outbox lag | Over 60 seconds |
| An execution running past its lease | Over 5 minutes |
| Queue depth rising | Over 10 minutes |
| Failure rate | Above 20 % over 15 minutes |

## Production readiness

The blueprint lists a production checklist. It is aspirational for this MVP, and the items that are **not** implemented
are called out in [limitations.md](limitations.md).

Implemented here:

- the audit log is append-only (a database trigger denies `UPDATE` and `DELETE`);
- secrets are encrypted with a rotatable master key, and the key id is stored beside every ciphertext;
- SSRF regression tests cover private ranges, redirects and IPv6;
- the worker heartbeats, the API exposes health and readiness checks, and the queue has diagnostics;
- the outbox rows are pruned after a fixed 7-day window; execution payload cleanup is not implemented.
