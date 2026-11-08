# syntax=docker/dockerfile:1
# The web app: Next.js standalone output.
#
# The standalone bundle keeps the monorepo layout, so the server entry is
# `packages/web/server.js` and the static assets belong next to it in
# `packages/web/.next/static`.
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# The pnpm store is a BuildKit cache, so a retried build resumes the download
# instead of starting over. Low concurrency keeps a slow registry from
# starving the large `next` and `@next/swc` tarballs.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --trust-lockfile --filter @s9/core --filter @s9/web \
      --store-dir=/pnpm-store \
      --network-concurrency=2 \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000

COPY packages/core packages/core
COPY packages/web packages/web

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @s9/core build && pnpm --filter @s9/web build

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone bundle contains the traced dependencies and the server.
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=build /app/packages/web/public ./packages/web/public

EXPOSE 3000
CMD ["node", "packages/web/server.js"]
