# syntax=docker/dockerfile:1
# The runtime image is selectable at build time; Bun is the default.
ARG RUNTIME_IMAGE=oven/bun:1-alpine

# The worker and the scheduler share the same image: only the command differs.
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# The pnpm store is a BuildKit cache, so a retried build resumes the download
# instead of starting over. Low concurrency keeps a slow registry from
# starving the large tarballs.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --trust-lockfile --filter @s9/core --filter @s9/server \
      --store-dir=/pnpm-store \
      --network-concurrency=2 \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000

COPY packages/core packages/core
COPY packages/server packages/server

RUN pnpm --filter @s9/core build && pnpm --filter @s9/server build

# Runtime stage: the Hono worker runs on Bun by default. Pass
# RUNTIME_IMAGE=node:22-alpine and RUNTIME_BIN=node to run on Node.js instead.
FROM ${RUNTIME_IMAGE} AS runtime
ARG RUNTIME_BIN=bun
ENV RUNTIME_BIN=${RUNTIME_BIN}

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/node_modules packages/server/node_modules
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/server/migrations packages/server/migrations

CMD ["sh", "-c", "exec \"$RUNTIME_BIN\" packages/server/dist/main-worker.js"]
