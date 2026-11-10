# syntax=docker/dockerfile:1
# One image for the API, the worker and the one-shot db steps (migrate, seed): same code, other
# entry point (infra/prod/compose.prod.yaml sets `command`). Build context = repository root:
#   docker build -f apps/api/Dockerfile .
# Built natively on the arm64 demo VM (T4.7); CI multi-arch builds come in T7.5.

FROM node:24.21.0-bookworm-slim AS build
# pnpm from the version pinned in package.json (packageManager), no global install.
RUN corepack enable
WORKDIR /repo
# Manifests first so the dependency layer is reused while only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --filter api...
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter contracts build && pnpm --filter api build
# Production dependencies only, with the workspace package (contracts) copied in, not linked.
RUN pnpm --filter api deploy --prod /out

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out/node_modules ./node_modules
COPY --from=build --chown=root:root /out/package.json ./package.json
COPY --from=build --chown=root:root /repo/apps/api/dist ./dist
# migrate.js reads ../../drizzle from dist/db (Phát sinh T1.3: the image must carry the SQL files).
COPY --from=build --chown=root:root /repo/apps/api/drizzle ./drizzle
# Committed eval summaries behind /insights (T4.6). JSON only: compare-v1.md quotes example values.
COPY --chown=root:root eval/reports/*.json ./eval-reports/
ENV EVAL_REPORTS_DIR=/app/eval-reports
# File storage (DATA_DIR). Owned by the runtime user so a new named volume mounted here starts
# with that owner (Docker copies the directory's ownership into an empty volume).
RUN mkdir /data && chown node:node /data
# The image's own non-root user. Code is owned by root, so the process cannot change it.
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
