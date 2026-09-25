# syntax=docker/dockerfile:1.7
# Production image for @bsh/degent-atelier (products/degent/services/atelier).
#
# Build context MUST be the repository root, so the pnpm workspace and the
# deps/scribbit submodule resolve:
#
#   git submodule update --init --recursive
#   docker build -f deploy/docker/atelier.Dockerfile -t degent-atelier:local .
#
# Unlike the other degent services, atelier depends on `sharp`, a native module
# with prebuilt per-platform binaries -- it is bundled as --external:sharp (see the
# package's "build" script) and its resolved node_modules subtree is copied into
# the runtime image separately via `pnpm deploy --prod` on the build image (same
# node:22-slim glibc base as the runtime, so the prebuilt linux-x64 binary matches).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @bsh/degent-atelier build
# Self-contained prod-only node_modules (resolves the `sharp` external + its deps
# into real files, not workspace symlinks) for the runtime stage below.
RUN pnpm --filter @bsh/degent-atelier deploy --prod --legacy /tmp/atelier-deploy

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788
WORKDIR /app
# DATABASE_PATH / CONTENT_DIR (env.schema.json) live under /data; unset (fake mode)
# runs in-memory.
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /tmp/atelier-deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/products/degent/services/atelier/dist/main.js ./main.js
USER node
EXPOSE 8788
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
