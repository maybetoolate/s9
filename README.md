# FlowForge

A small, self-hostable workflow engine for technical operators who need **execution transparency** and **safe recovery**.

Configure a process once, run it repeatedly, and understand every run. FlowForge persists each execution and each
step result, so you can see exactly what happened and recover from failures without silent repeats.

It is deliberately **not** a Zapier or n8n replacement: it does less, but every run is inspectable and every failure is
recoverable.

---

## What it does

| Capability | Status |
| --- | --- |
| Triggers | Webhook (HMAC signed), Schedule (cron + timezone), Manual |
| Actions | HTTP request, Send email, Database insert, Notification |
| Execution | Sequential steps, PostgreSQL-backed history, per-step attempts |
| Reliability | Transactional outbox, BullMQ queue, database leases, bounded retries, stale-run reconciler |
| Recovery | Retry a failed step in place, rerun a whole execution, resolve an unknown outcome manually |
| UI | Dashboard, linear workflow builder, execution timeline, attempt history, audit log |
| Access control | One workspace, three roles (owner / editor / viewer), every query scoped to the workspace |

### The idea in one paragraph

Every trigger — webhook, schedule or manual — enters the same pipeline: an execution row and an outbox event are
written in one PostgreSQL transaction, a dispatcher publishes the work to BullMQ, and a worker claims the execution
under a database lease and runs the steps. Failures are classified (validation, permanent, transient, rate limited,
timeout, infrastructure), retried with exponential backoff and jitter when that is safe, and otherwise surfaced with
enough context to act on. A timeout on a side-effecting action becomes `outcome_unknown` instead of an automatic
retry, because a timeout does not prove the remote operation failed.

---

## Quick start

Requirements: Docker (for PostgreSQL and Redis) and Node.js 20.11+.

```bash
# 1. Configure the environment
cp .env.example .env
# Generate the two secrets and put them into .env:
#   ENCRYPTION_KEY=$(openssl rand -base64 32)
#   SESSION_SECRET=$(openssl rand -hex 32)

# 2. Start PostgreSQL, Redis and the local mail catcher
docker compose up -d postgres redis mailpit

# 3. Install, migrate and seed
pnpm install
pnpm db:migrate
pnpm db:seed

# 4. Run the API, the worker, the scheduler and the web app
pnpm dev
```

The web app runs on <http://localhost:3000>, the API on <http://localhost:4100>, and the mail catcher on
<http://localhost:8025>.

Sign in with the seeded operator:

```
email:    operator@flowforge.local
password: flowforge-demo-password
```

### Everything in Docker

```bash
docker compose up --build -d

# Seed inside the container network: the demo workflow stores the address of
# the demo sink, and the worker has to be able to reach it.
docker compose exec api node packages/server/dist/cli-seed.js
```

This starts `web`, `api`, `worker`, `scheduler`, `postgres`, `redis`, `mailpit` and `sink`. The API applies its migrations
on start.

The seed has to run in the same environment as the worker: it stores the demo notification destination in the workflow
definition, and the worker has to be able to reach it. The seed warns when the destination is not reachable.

### One-command database reset

```bash
pnpm db:reset && pnpm db:migrate && pnpm db:seed
```

---

## Trying it out

The seed creates a **Contact form follow-up** workflow: a webhook trigger, then *save contact* → *send confirmation
email* → *notify sales*. Publish it from the UI to activate it and copy the webhook secret that is shown once.

```bash
# Sign the request exactly like the UI does
SECRET="whsec_..."
BODY='{"name":"Ada Lovelace","email":"ada@example.com","message":"Hello!"}'
TS=$(date +%s000)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -i -X POST "http://localhost:4100/webhooks/<slug>" \
  -H "content-type: application/json" \
  -H "idempotency-key: demo-1" \
  -H "x-flowforge-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

You get `202 Accepted` with an execution id. Open the execution in the UI to watch the steps run, and repeat the
request with the same idempotency key to see the duplicate being rejected with `200`.

The signature is computed by the **sender**: it is the hex HMAC-SHA256 of `<timestamp>.<body>`, keyed with the endpoint
secret, sent as `X-FlowForge-Signature: t=<unix-ms>,v1=<hex>`. The secret is shown once when the endpoint is created;
if you no longer have it, rotate it in the workflow's **Webhook** tab. The same tab has a **Send a signed test
delivery** button that signs and delivers a sample payload and shows you the exact request it sent.

---

## Repository layout

```
packages/
  core/     shared domain logic: limits, state machine, definition schema,
            variable mapping, error taxonomy, schedule resolution, SSRF rules
  server/   API, worker, scheduler, action adapters, migrations, tests
  web/      Next.js app (dashboard, builder, execution history)
docs/       architecture, API reference, operations guide, ADRs, limitations
docker/     container images for the api, worker and web app
```

The API and the worker share one codebase but run as separate processes, exactly as the blueprint requires.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, the execution lifecycle, the outbox, leases, the state machines |
| [docs/api.md](docs/api.md) | REST endpoints, the error envelope, webhook signature verification, pagination |
| [docs/operations.md](docs/operations.md) | Local troubleshooting, queue inspection, database reset, metrics and alerts |
| [docs/state-machines.md](docs/state-machines.md) | Every allowed transition and every guard |
| [docs/limitations.md](docs/limitations.md) | What FlowForge does **not** do, and why |
| [docs/adr/](docs/adr) | The decisions that shaped the system |

---

## Tests

```bash
pnpm test:unit          # pure logic: state machine, mapping, schedules, SSRF, taxonomy
pnpm test:integration   # the real API, the real database, the real engine
pnpm typecheck
```

The integration suite covers the critical scenarios: one accepted execution per idempotency key, rejection of
unauthenticated webhooks, ordered step execution, bounded retries, permanent failures, `outcome_unknown` handling,
manual resolution without editing attempt history, retry without repeating successful steps, one recovery for two
simultaneous retry requests, immutable published versions, and workspace isolation.

The integration tests need PostgreSQL and Redis; they use a dedicated `flowforge_test` database so they never touch
your development data.

---

## Guarantees and non-guarantees

**Guaranteed**

- Every accepted execution is persisted, and every state change is recorded.
- A published version is immutable: existing runs keep running the version they pinned.
- No terminal state is ever overwritten by a late duplicate queue delivery.
- A failed step can be retried without repeating the steps that already succeeded.
- Secrets never appear in logs or API responses.

**Not guaranteed**

- Exactly-once side effects. Delivery is at-least-once; a provider without idempotency support can see a repeated
  request. Steps carry a stable idempotency key so providers that support it can collapse the repeat, and uncertain
  outcomes are surfaced as `outcome_unknown` instead of being retried blindly.
- Branching, loops, parallel fan-out, sub-workflows and human approvals — out of scope for the MVP.

See [docs/limitations.md](docs/limitations.md) for the full list.

---

## Licence

MIT.
