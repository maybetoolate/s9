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

RUN pnpm install --frozen-lockfile --filter @flowforge/core --filter @flowforge/web

COPY packages/core packages/core
COPY packages/web packages/web

ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @flowforge/core build && pnpm --filter @flowforge/web build

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
