# syntax=docker/dockerfile:1.7
# Production image for @bsh/degent-mint (products/degent/services/mint).
#
# Build context MUST be the repository root (this repo's root, not this service's
# directory), so the pnpm workspace (pnpm-workspace.yaml) and the deps/scribbit
# submodule (platform/*, tools/*) resolve. From the repo root:
#
#   git submodule update --init --recursive   # once, if deps/scribbit isn't checked out
#   docker build -f deploy/docker/mint.Dockerfile -t degent-mint:local .
#
# The build stage bundles src/main.ts plus the workspace-internal @bsh/* platform
# packages (which ship as TypeScript source, not a build output) into one file with
# esbuild -- see the package's "build" script in
# products/degent/services/mint/package.json. The runtime stage therefore ships no
# TypeScript toolchain, tsx, or dev dependencies: just node + the bundle.
#
# Validated (this change): `docker build` of this exact multi-stage pipeline against
# a real vendored install, run as the non-root `node` user, listening on 0.0.0.0 and
# passing its own HEALTHCHECK against GET /v1/health. See DEPLOY.md for the one
# difference in a fully offline sandbox (corepack's pnpm fetch needs open internet;
# any normal CI runner has it).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

# ---- deps: install the whole workspace (pnpm needs the full graph to resolve) ----
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# ---- build: typecheck + bundle just this service ----
FROM deps AS build
RUN pnpm --filter @bsh/degent-mint build

# ---- runtime: nothing but node + the bundle ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
# Volume mount points for DATABASE_PATH / CONTENT_DIR (see env.schema.json); owned
# by the non-root `node` user baked into the node:* images.
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /workspace/products/degent/services/mint/dist/main.js ./main.js
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
