# syntax=docker/dockerfile:1.7
#
# @bsh/degent-mint: API, worker and sqlite backup images from one Dockerfile (docs/DEPLOY.md).
#
#   git submodule update --init            # deps/scribbit must be present (platform packages)
#   docker build -f products/degent/deploy/mint.Dockerfile -t degent/mint .                  # api/worker
#   docker build -f products/degent/deploy/mint.Dockerfile --target backup -t degent/mint-backup .
#
#   docker run degent/mint api       # HTTP API only           (MINT_ROLE=api)
#   docker run degent/mint worker    # worker + /v1/health     (MINT_ROLE=worker); run exactly one
#   docker run degent/mint all       # both in one process
#
# Build context: the repository root. Workspace packages export TypeScript, so the service is bundled
# (esbuild, `pnpm --filter @bsh/degent-mint build`) into dist/main.mjs; the runtime image has no node_modules.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ENV CI=true PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Manifests first so the dependency layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY deps/scribbit/platform/inscription/package.json deps/scribbit/platform/inscription/
COPY deps/scribbit/platform/identity/package.json deps/scribbit/platform/identity/
COPY deps/scribbit/platform/events/package.json deps/scribbit/platform/events/
COPY products/degent/packages/mint-sdk/package.json products/degent/packages/mint-sdk/
COPY products/degent/services/mint/package.json products/degent/services/mint/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@bsh/degent-mint..."
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @bsh/degent-mint build \
 && pnpm --filter @bsh/degent-mint deploy --legacy --prod /out \
 && test -f /out/dist/main.mjs && test -f /out/dist/signet-parent.mjs

# -------------------------------------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="degent-mint" \
      org.opencontainers.image.source="https://github.com/DegentClub/degent" \
      org.opencontainers.image.description="degent.club non-custodial mint service (API + worker)"
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/var/lib/degent-mint/mint.db \
    CONTENT_DIR=/var/lib/degent-mint/content
WORKDIR /app
# Only the bundle, the Gallery roster and the manifests: no sources, no tests, no node_modules.
COPY --from=build --chown=root:root /out/dist ./dist
COPY --from=build --chown=root:root /out/data ./data
COPY --from=build --chown=root:root /out/package.json /out/env.schema.json ./
RUN mkdir -p /var/lib/degent-mint/content && chown -R node:node /var/lib/degent-mint
VOLUME ["/var/lib/degent-mint"]
USER node
EXPOSE 8787
# Liveness only: /v1/health answers 200 with status "degraded" while a backend is down (alert on that
# from logs, do not restart-loop on it). The worker role serves /v1/health too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.mjs"]
CMD ["api"]

# --------------------------------------------------------------------------------------------- backup
# sqlite online backup (`.backup`) + content blobs, on an interval. Mount the mint data volume at
# /var/lib/degent-mint and a backup target at /backups. See products/degent/deploy/backup.sh.
FROM alpine:3.20 AS backup
RUN apk add --no-cache sqlite \
 && addgroup -g 1000 node && adduser -D -u 1000 -G node node \
 && mkdir -p /backups && chown node:node /backups
COPY --chmod=0755 products/degent/deploy/backup.sh /usr/local/bin/degent-mint-backup
ENV DATABASE_PATH=/var/lib/degent-mint/mint.db CONTENT_DIR=/var/lib/degent-mint/content BACKUP_DIR=/backups \
    BACKUP_INTERVAL_SECONDS=3600 BACKUP_KEEP=48
USER node
# Healthy while the newest backup is younger than two intervals.
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m --retries=1 \
  CMD ["/usr/local/bin/degent-mint-backup", "--check"]
ENTRYPOINT ["/usr/local/bin/degent-mint-backup"]
CMD ["--loop"]
