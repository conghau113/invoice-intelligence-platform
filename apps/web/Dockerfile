# syntax=docker/dockerfile:1
# Next.js web server (BFF) from the standalone build. Build context = repository root:
#   docker build -f apps/web/Dockerfile .
# Built natively on the arm64 demo VM (T4.7); CI multi-arch builds come in T7.5.
# Note: next/font/google downloads the font during the build, so the build needs internet
# (Phát sinh T3.9/T4.1: switch to next/font/local in T7.4).

FROM node:24.21.0-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT_STANDALONE=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter web...
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter contracts build && pnpm --filter web build

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# server.js plus only the node_modules Next traced. Static assets are not part of standalone.
# apps/web has no public/ folder today; if one is added (favicon, robots.txt), copy it here too:
#   COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
