# The web app: Next.js standalone output.
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

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/node_modules packages/core/node_modules
COPY --from=build /app/packages/web/package.json packages/web/
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static packages/web/.next/static
COPY --from=build /app/packages/web/public packages/web/public

EXPOSE 3000
CMD ["node", "packages/web/server.js"]
