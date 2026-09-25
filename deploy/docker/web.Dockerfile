# syntax=docker/dockerfile:1.7
# Production image for @bsh/degent-web (products/degent/apps/web): a static Vite
# build served by a ~90-line dependency-free Node static server
# (deploy/docker/static-server.mjs). nginx:alpine is an equally valid alternative
# (see DEPLOY.md); this keeps every image in the fleet on the same node:22-slim
# base and avoids a second base image to pull/patch.
#
# Build context MUST be the repository root, so the pnpm workspace and the
# deps/scribbit submodule resolve:
#
#   git submodule update --init --recursive
#   docker build -f deploy/docker/web.Dockerfile -t degent-web:local .
#
# VITE_* variables are inlined into the JS bundle at build time (Vite convention),
# not read at container start -- pass them as --build-arg (see the ARGs below and
# compose.signet.yml's `build.args`). Rebuild the image to change them.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_NETWORK=signet
ARG VITE_MINT_API_URL
ARG VITE_STUDIO_API_URL
ARG VITE_ESPLORA_URL
ARG VITE_EXPLORER_URL
ARG VITE_ORD_URL
ARG VITE_CERTIFY_URL
ARG VITE_COLLECTION_SLUG
ARG VITE_POLL_MS
ARG VITE_GALLERY_PAGE_SIZE
ARG VITE_COMIC_INSCRIPTION_ID
ENV VITE_NETWORK=$VITE_NETWORK \
    VITE_MINT_API_URL=$VITE_MINT_API_URL \
    VITE_STUDIO_API_URL=$VITE_STUDIO_API_URL \
    VITE_ESPLORA_URL=$VITE_ESPLORA_URL \
    VITE_EXPLORER_URL=$VITE_EXPLORER_URL \
    VITE_ORD_URL=$VITE_ORD_URL \
    VITE_CERTIFY_URL=$VITE_CERTIFY_URL \
    VITE_COLLECTION_SLUG=$VITE_COLLECTION_SLUG \
    VITE_POLL_MS=$VITE_POLL_MS \
    VITE_GALLERY_PAGE_SIZE=$VITE_GALLERY_PAGE_SIZE \
    VITE_COMIC_INSCRIPTION_ID=$VITE_COMIC_INSCRIPTION_ID
RUN pnpm --filter @bsh/degent-web build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ROOT_DIR=/app/dist
WORKDIR /app
COPY --chown=node:node deploy/docker/static-server.mjs ./static-server.mjs
COPY --from=build --chown=node:node /workspace/products/degent/apps/web/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "static-server.mjs"]
