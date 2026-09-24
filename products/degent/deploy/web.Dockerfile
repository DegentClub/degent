# syntax=docker/dockerfile:1.7
#
# @bsh/degent-web: Vite build -> static files served by Caddy (security headers, SPA fallback, immutable
# hashed assets, /api/* reverse-proxied to the mint API so the browser stays same-origin). docs/DEPLOY.md.
#
#   git submodule update --init
#   docker build -f products/degent/deploy/web.Dockerfile \
#     --build-arg VITE_NETWORK=signet --build-arg VITE_ESPLORA_URL=https://esplora.example/signet/api \
#     -t degent/web .
#
# VITE_* values are compiled into the bundle (they are public). Unset or empty build args fall back to the
# app's defaults (src/config.ts): the API is /api on the same origin.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG CADDY_IMAGE=caddy:2.8-alpine

# ---------------------------------------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
ENV CI=true PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY deps/scribbit/platform/inscription/package.json deps/scribbit/platform/inscription/
COPY deps/scribbit/platform/wallet-kit/package.json deps/scribbit/platform/wallet-kit/
COPY products/degent/packages/mint-sdk/package.json products/degent/packages/mint-sdk/
COPY products/degent/apps/web/package.json products/degent/apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@bsh/degent-web..."
COPY . .
ARG VITE_NETWORK=mainnet
ARG VITE_MINT_API_URL=/api
ARG VITE_ESPLORA_URL
ARG VITE_EXPLORER_URL
ARG VITE_ORD_URL
ARG VITE_POLL_MS
ARG VITE_GATE_URL
ARG VITE_SITE_URL
# Empty build args must not reach Vite as "" (the app treats "" as a value, not as unset).
RUN for v in VITE_NETWORK VITE_MINT_API_URL VITE_ESPLORA_URL VITE_EXPLORER_URL VITE_ORD_URL VITE_POLL_MS VITE_GATE_URL VITE_SITE_URL; do \
      eval "val=\${$v:-}"; if [ -z "$val" ]; then unset "$v"; else export "$v"; fi; \
    done \
 && pnpm --filter @bsh/degent-web build \
 && find products/degent/apps/web/dist -name '*.map' -delete \
 && test -f products/degent/apps/web/dist/index.html

# -------------------------------------------------------------------------------------------- runtime
FROM ${CADDY_IMAGE} AS runtime
LABEL org.opencontainers.image.title="degent-web" \
      org.opencontainers.image.source="https://github.com/DegentClub/degent" \
      org.opencontainers.image.description="degent.club mint front end (static, served by Caddy)"
RUN addgroup -g 10001 web && adduser -D -H -u 10001 -G web web \
 && mkdir -p /data /config && chown -R web:web /data /config
COPY --chown=root:root products/degent/deploy/Caddyfile products/degent/deploy/web-site.caddy /etc/caddy/
COPY --from=build --chown=root:root /repo/products/degent/apps/web/dist /srv
ENV SITE_ADDRESS=:8080 MINT_API_UPSTREAM=mint-api:8787 XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
USER web
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
