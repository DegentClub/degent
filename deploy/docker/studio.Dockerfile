# syntax=docker/dockerfile:1.7
# Production image for @bsh/degent-studio (products/degent/services/studio).
#
# Build context MUST be the repository root, so the pnpm workspace and the
# deps/scribbit submodule resolve:
#
#   git submodule update --init --recursive
#   docker build -f deploy/docker/studio.Dockerfile -t degent-studio:local .
#
# See mint.Dockerfile for the full explanation of the esbuild-bundle approach.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @bsh/degent-studio build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790
WORKDIR /app
# DATABASE_PATH / CONTENT_DIR (env.schema.json) live under /data.
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /workspace/products/degent/services/studio/dist/main.js ./main.js
USER node
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.js"]
