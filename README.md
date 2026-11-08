# s9

A small, self-hostable workflow engine for technical operators who need **execution transparency** and **safe recovery**.

Configure a process once, run it repeatedly, and understand every run. s9 persists each execution and each
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

Requirements: Docker (for PostgreSQL and Redis), Node.js 22.18+ for the web app and the tsdown build tooling, and either Bun 1.1+ or Node.js 22+ for the API (which embeds authentication), worker and scheduler. Bun is the default runtime; the Docker images and dev scripts use it.

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

# 4. Run the API (authentication included), the worker, the scheduler and the web app
pnpm dev
```

The web app runs on <http://localhost:3000>, the API on <http://localhost:4100>, and the mail catcher on
<http://localhost:8025>. Authentication is served by the API itself at `/api/auth/*`.

### Node.js runtime

The server processes are Hono applications, so they run on Node.js as well as Bun. Build the server once and start the
processes with the `:node` scripts:

```bash
pnpm --filter @s9/server build
pnpm --filter @s9/server start:api:node
pnpm --filter @s9/server start:worker:node
pnpm --filter @s9/server start:scheduler:node
```

The runtime is detected at startup. Docker images keep Bun as the default; to build them for Node.js instead, set
`RUNTIME_IMAGE=node:22-alpine` and `RUNTIME_BIN=node` when running Compose, for example:

```bash
RUNTIME_IMAGE=node:22-alpine RUNTIME_BIN=node docker compose up --build -d
```

Sign in with the seeded operator:

```
email:    operator@s9.local
password: s9-demo-password
```

### Everything in Docker

```bash
docker compose up --build -d

# Seed inside the container network: the demo workflow stores the address of
# the demo sink, and the worker has to be able to reach it.
docker compose exec api bun packages/server/dist/cli-seed.js
```

This starts `web`, `api`, `worker`, `scheduler`, `postgres`, `redis`, `mailpit`, `sink` and `dozzle`. The API, the worker
and the scheduler apply migrations on start (serialised by an advisory lock), so they can start in any order.

Authentication is embedded in the API process: Better-Auth shares the application Drizzle client and owns only its
`user`, `session`, `account` and `verification` tables. No separate auth container or shared service secret is needed;
the browser only talks to the API's `/api/auth/*` surface.

The seed has to run in the same environment as the worker: it stores the demo notification destination in the workflow
definition, and the worker has to be able to reach it. The seed warns when the destination is not reachable.

### Logs

The services write structured JSON logs. Instead of reading the raw stream, use one of these:

- **Web log viewer** — <http://localhost:8080> (Dozzle). Start it with `docker compose up -d dozzle`; it lists every
  container in the project, follows logs live, and lets you search, filter by level and switch containers.
- **Pretty CLI logs** — `pnpm logs` follows `api`, `worker` and `scheduler` through `pino-pretty`. Use
  `pnpm logs:api`, `pnpm logs:worker`, `pnpm logs:scheduler` or `pnpm logs:web` for a single service.

```bash
docker compose up -d dozzle   # then open http://localhost:8080
pnpm logs:api                 # human-readable, colourised API log
```

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
  -H "x-s9-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

You get `202 Accepted` with an execution id. Open the execution in the UI to watch the steps run, and repeat the
request with the same idempotency key to see the duplicate being rejected with `200`.

The signature is computed by the **sender**: it is the hex HMAC-SHA256 of `<timestamp>.<body>`, keyed with the endpoint
secret, sent as `X-S9-Signature: t=<unix-ms>,v1=<hex>`. The secret is shown once when the endpoint is created;
if you no longer have it, rotate it in the workflow's **Webhook** tab. The same tab has a **Send a signed test
delivery** button that signs and delivers a sample payload and shows you the exact request it sent.

---

## Repository layout

```
packages/
  core/     shared domain logic: limits, state machine, definition schema,
            variable mapping, error taxonomy, schedule resolution, SSRF rules
  server/   API with embedded auth, worker, scheduler, action adapters, Drizzle schema and migrations, tests
  web/      Next.js app (dashboard, builder, execution history)
  neovim/   companion Neovim plugin: workflows, runs and recovery
docs/       architecture, API reference, operations guide, ADRs, limitations
docker/     container images for the api, worker and web app
```

The API, the worker and the scheduler share one codebase but run as separate processes. Authentication is a module
inside the API, not a separate service, so the API is the only browser-facing process.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, the execution lifecycle, the outbox, leases, the state machines |
| [docs/api.md](docs/api.md) | REST endpoints, the error envelope, webhook signature verification, pagination |
| [docs/operations.md](docs/operations.md) | Local troubleshooting, queue inspection, database reset, metrics and alerts |
| [docs/state-machines.md](docs/state-machines.md) | Every allowed transition and every guard |
| [docs/limitations.md](docs/limitations.md) | What s9 does **not** do, and why |
| [docs/adr/](docs/adr) | The decisions that shaped the system |
| [packages/neovim/README.md](packages/neovim/README.md) | Install and use the Neovim companion plugin |

---

## Tests

```bash
pnpm test:unit          # pure logic: state machine, mapping, schedules, SSRF, taxonomy
pnpm test:integration   # the real API, the real database, the real engine
pnpm test:e2e           # the real UI in a browser, against the real stack
pnpm typecheck
```

The integration suite covers the critical scenarios: one accepted execution per idempotency key, rejection of
unauthenticated webhooks, ordered step execution, bounded retries, permanent failures, `outcome_unknown` handling,
manual resolution without editing attempt history, retry without repeating successful steps, one recovery for two
simultaneous retry requests, immutable published versions, and workspace isolation.

The integration tests need PostgreSQL and Redis; they use a dedicated `s9_test` database so they never touch
your development data.

### End-to-end tests

The Playwright suite drives the browser against a real stack: the API, its embedded authentication, the worker and
the Next.js web app. It covers sign-in and sign-out, the workflow wizard, validation and publishing, a production run
(with the worker executing it), a simulated test run, the execution history filters and the credential lifecycle.

`pnpm test:e2e` rebuilds the dedicated `s9_e2e` database from the Drizzle baseline, seeds the demo workspace and
flushes Redis database `1` before Playwright starts the servers on ports `4200` (API) and `3100` (web). The
configuration lives in `.env.e2e`; variables already set in the process environment take precedence, so CI can point
the suite at its own services. The development stack on ports `3000`/`4100` and Redis database `0` is never touched.

```bash
pnpm --filter @s9/web exec playwright install chromium   # once per machine
pnpm test:e2e
pnpm test:e2e:ui                                        # interactive mode
```

Playwright writes traces and screenshots to `packages/web/test-results` and the HTML report to
`packages/web/playwright-report`.


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
