# Build stage: install the workspace and compile the server packages.
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN pnpm install --frozen-lockfile --filter @s9/core --filter @s9/server

COPY packages/core packages/core
COPY packages/server packages/server

RUN pnpm --filter @s9/core build && pnpm --filter @s9/server build

# Runtime stage.
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
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
# The API and the auth service apply migrations on start, so they travel with
# the image.
COPY --from=build /app/packages/server/migrations packages/server/migrations

EXPOSE 4000 4001
CMD ["node", "packages/server/dist/main-api.js"]
