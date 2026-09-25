# Deploying degent.club

This covers building production images for the Open Studio services
(`@bsh/degent-mint`, `@bsh/degent-studio`, `@bsh/degent-atelier`, `@bsh/degent-web`),
running the signet staging stack, the secrets it needs, health checks, and the
go-live checklist for `roadmap.json` items `p5.6` (signet game day) and `p6.3`
(mainnet launch).

For what the infra team (Scribbitt/infrastructure) needs to add to the fleet
(NixOS module hosts, DNS, CT numbering), see [`docs/fleet-handoff.md`](docs/fleet-handoff.md).
This document is intentionally infra-repo-agnostic: it only assumes Docker.

## Prerequisites

- `git submodule update --init --recursive` -- `deps/scribbit` (the platform
  packages) must be checked out; the pnpm workspace and every Dockerfile here
  assume it.
- Docker with BuildKit (Docker 23+; `DOCKER_BUILDKIT=1` if not already the
  default).
- The build context for every Dockerfile in `deploy/docker/` is **the repository
  root**, not the service directory -- the pnpm workspace (`pnpm-workspace.yaml`)
  spans `products/*/{apps,services,packages}` and `deps/scribbit/{platform,tools}`,
  and `pnpm install` needs the whole graph. Always build with `-f
  deploy/docker/<service>.Dockerfile .` from the repo root (or `deploy/compose.signet.yml`,
  which already sets `context: ..`).

## Building images

```bash
git submodule update --init --recursive

docker build -f deploy/docker/mint.Dockerfile    -t degent-mint:latest    .
docker build -f deploy/docker/studio.Dockerfile  -t degent-studio:latest  .
docker build -f deploy/docker/atelier.Dockerfile -t degent-atelier:latest .
docker build -f deploy/docker/web.Dockerfile     -t degent-web:latest    \
  --build-arg VITE_NETWORK=mainnet \
  --build-arg VITE_MINT_API_URL=https://mint.degent.club \
  --build-arg VITE_STUDIO_API_URL=https://studio.degent.club \
  .
```

Each backend Dockerfile is multi-stage: a `deps` stage runs
`pnpm install --frozen-lockfile` against the whole workspace, a `build` stage runs
that service's `pnpm --filter <pkg> build` (typecheck with `tsc`, then bundle
`src/main.ts` plus the workspace's `@bsh/*` platform packages -- which ship as
TypeScript source, not a build output -- into one file with `esbuild`), and the
`runtime` stage is bare `node:22-slim` plus that one bundle, run as the
non-root `node` user. `degent-atelier` additionally ships a pruned
production-only `node_modules/sharp` (via `pnpm deploy --prod --legacy`) since
`sharp` is a native module and stays external to the bundle. `degent-web` is a
static `vite build` served by `deploy/docker/static-server.mjs`, a ~90-line
dependency-free Node static file server (an `nginx:alpine` runtime stage is an
equally valid swap -- see the comment at the top of `web.Dockerfile`); `VITE_*`
vars are baked in at build time via `--build-arg`, not read at container start.

**package.json changes**: each of `mint`, `studio`, `atelier` got one additive
`"build"` script (`tsc --noEmit -p . && pnpm exec esbuild ...`); nothing else in
those files changed, and `"start"` (already `tsx src/main.ts`, a real
non-watching production start command) was left as-is. Confirmed locally:

```bash
pnpm --filter @bsh/degent-mint build     # dist/main.js, 1.3mb, 0 warnings
pnpm --filter @bsh/degent-studio build   # dist/main.js, 1.1mb, 0 warnings
pnpm --filter @bsh/degent-atelier build  # dist/main.js, 900kb (sharp external), 0 warnings
pnpm --filter @bsh/degent-web build      # vite build (pre-existing script, unchanged)
```

### Validation actually run in this environment

`docker build` was run end to end for **`mint`** and **`web`**, the two
representative builds the task asked for:

| Image | Result | Disk size (uncompressed) | Compressed |
|---|---|---|---|
| `degent-mint` | built, ran, `GET /v1/health` returned 200, container `HEALTHCHECK` reported `healthy` | 328MB | 80.1MB |
| `degent-web` | built, ran, `GET /healthz` returned 200, served `index.html` | 331MB | 80.7MB |

Both were run as the non-root `node` user (`docker exec ... whoami` → `node`) and
listened on `0.0.0.0` inside the container.

**One environment-specific caveat, not a Dockerfile defect**: the sandbox this
was built in only allows outbound network from the host process, not from
inside a container's build step (even proxied) -- so the `deps` stage's
`pnpm install --frozen-lockfile` (which needs corepack to fetch the pinned
`pnpm@10.33.0` from the registry) could not be exercised inside a container
*here*. This is a property of this validation sandbox, not of the Dockerfile:
any normal CI runner or dev machine with regular internet egress builds it as
written, with no special flags. To validate everything *else* -- the
`tsc`+`esbuild` build stage, the runtime image layout, the non-root user, the
`HEALTHCHECK`, and an actual running container answering its health endpoint --
the two builds above were run against a pre-vendored `node_modules` (installed
on the host beforehand, the normal way) instead of a fresh `pnpm install`
inside the container. `studio` and `atelier` were not independently
`docker build`-validated (only their `pnpm --filter ... build` script was
confirmed); they are structurally identical to `mint`, with `atelier` adding
the `sharp` deploy step, which was smoke-tested locally against the built
bundle (see `pnpm --filter @bsh/degent-atelier build` output above; the actual
container packaging for atelier was not run in this session).

## Running the signet staging stack

```bash
cp deploy/.env.example deploy/.env   # fill in values -- see "Secrets" below
docker compose -f deploy/compose.signet.yml --env-file deploy/.env config   # validate (confirmed passing)
docker compose -f deploy/compose.signet.yml --env-file deploy/.env up -d --build
```

This brings up `rabbitmq`, `mint`, `studio`, `atelier` and `web`, each built
from this repo's own Dockerfiles, wired with the env each service's
`env.schema.json` requires. It does **not** bring up the platform `signer` or
`ledger` -- those are shared platform services from `DegentClub/scribbit`
(`deps/scribbit/platform/{signer,ledger}`) that in staging/production run on
the fleet; `SIGNER_URL` / `LEDGER_URL` point at them. See
[`docs/fleet-handoff.md`](docs/fleet-handoff.md) for what infra needs to stand
those up, and `/home/user/scribbit/DEPLOY.md` for building/running them
directly if you want a fully local stack.

**Storage**: every service here uses `node:sqlite` (`DATABASE_PATH` is a single
file), never Postgres -- there is no Postgres dependency anywhere in the actual
application config surface (`env.schema.json` for each service only accepts a
file path). Each service gets its own named volume under `/data` (the sqlite
file plus a content-addressed blob directory). This is documented rather than
invented, per the task's own note that sqlite volumes are an acceptable
alternative to Postgres here.

**Bitcoin endpoints**: `ESPLORA_URL` / `ORD_URL` / `LIBRE_RPC_URL` must point at
the fleet's **signet** stack, never mainnet or testnet, and never a hardcoded
IP -- resolve the current addresses with `fleet dev connect btc-signet` /
`fleet dev connect indexer-signet` from the infra repo, or
`curl https://fleet-mcp.hs.skrybit.dev/api/services/btc-signet` from anywhere.

## Secrets

No secret values live in this repo. `deploy/.env.example` lists every variable
each service's `env.schema.json` marks `x-secret`, with the SOPS path a real
value would come from, values left blank. Fetch real values from the fleet's
secret store (see `/home/user/infrastructure` CLAUDE.md, "Secrets (SOPS)"),
never commit `deploy/.env`:

| Secret | SOPS path |
|---|---|
| Mint reveal encryption key | `services/degent-mint/reveal-encryption-key` |
| Mint → signer API key | `services/degent-mint/signer-api-key` |
| Mint → studio API key | `services/degent-mint/studio-api-key` |
| Mint → ledger API key | `services/degent-mint/ledger-api-key` |
| Mint admin API key hashes | `services/degent-mint/admin-api-key-hashes` |
| Mint art-review (Anthropic) key | `services/degent-mint/art-review-api-key` |
| Mint Libre Relay RPC password | `services/degent-mint/libre-rpc-pass` |
| Mint Slipstream API key | `services/degent-mint/slipstream-api-key` |
| Studio session signing key | `services/degent-studio/session-signing-key` |
| Studio API keys | `services/degent-studio/api-keys` |
| Studio vision-review (Anthropic) key | `services/degent-studio/vision-review-api-key` |
| Studio Telegram bot token | `services/degent-studio/telegram-bot-token` |
| Atelier OpenAI key | `services/degent-atelier/openai-api-key` |
| Atelier HTTP provider key | `services/degent-atelier/http-provider-api-key` |
| Atelier vision-review key | `services/degent-atelier/vision-review-api-key` |
| RabbitMQ password | `services/rabbitmq/degent-password` |

The remote signer key itself (the collection parent key) never leaves
`platform/signer`; mint only ever holds a scoped `sign:<key id>` API key.

## Health endpoints

| Service | Path | Notes |
|---|---|---|
| mint | `GET /v1/health` | Reports store/chain-backend/parent/bus sub-checks; `degraded` (not `ok`) until a parent UTXO + chain backend are configured, this is expected pre-launch. |
| studio | `GET /v1/health` | |
| atelier | `GET /v1/health` | `fake` mode always reports healthy; a real provider reports its own reachability. |
| web | `GET /healthz` | Served by the static server itself, no disk access. |

## Go-live checklist

### `p5.6` -- Signet game day (`roadmap.json`, depends on `p5.1`, `p5.3`)

- [ ] `docker compose -f deploy/compose.signet.yml up -d --build` against the
      fleet's signet `bitcoind`/`esplora`/`ord` and a real `platform/signer`
      + `platform/plane` deployment (see `docs/fleet-handoff.md`).
- [ ] Mint a Standard, a Large and a Full Block Degent end to end on signet;
      confirm the reveal confirms and the rescue path (`GET /rescue`) returns
      real inputs.
- [ ] Submit and approve one Studio artwork order; confirm the royalty line
      item lands in the ledger (or the in-memory fake if `LEDGER_URL` unset)
      and the mint's `STUDIO_URL` health sub-check is green.
- [ ] Confirm `AMQP_URL` is set and `rabbitmq` shows the bus connected
      (mint's `GET /v1/health` `bus` check, and `rabbitmq`'s own
      `HEALTHCHECK`) -- signet only *warns* on an unset `AMQP_URL`, game day
      should run with it wired for real, matching mainnet's requirement.
- [ ] Load-test the standard-lane concurrency limit (`STANDARD_CONCURRENCY`)
      against a full mempool to confirm the 25-descendant chain limit holds.
- [ ] Confirm `degent-web` served at the staging domain resolves against the
      signet mint/studio, not `localhost` (`VITE_MINT_API_URL` /
      `VITE_STUDIO_API_URL` build args).
- [ ] File `p5.5` (security review) findings against upload path, royalty
      verification, and internal endpoints before signing off game day as
      "go."

### `p6.3` -- Mainnet launch (depends on `p5.6`, `p6.1`)

- [ ] Rebuild every image with `--build-arg VITE_NETWORK=mainnet` and mainnet
      `ESPLORA_URL`/`ORD_URL`/`LIBRE_RPC_URL` or `SLIPSTREAM_URL` (mainnet
      requires at least one block-lane broadcaster; signet's esplora-only
      fallback is refused).
- [ ] `SIGNER=remote` is the only option outside regtest and is already the
      default in every Dockerfile here; confirm the live `SIGNER_API_KEY`
      (`bsh_live_...`) and that `platform/signer`'s key provider is backed by
      the real HSM/KMS, not a dev key file.
- [ ] `AMQP_URL` is **required** on mainnet (startup refuses without it) --
      confirm the mainnet RabbitMQ cluster is reachable before flipping
      `NETWORK=mainnet`.
- [ ] `MINT_ADMIN_API_KEYS_JSON` set with `env: "live"` records; confirm
      `/v1/admin/*` is unreachable without one.
- [ ] Curated first wave: confirm `PARENT_INSCRIPTION_ID` / `COLLECTION_ADDRESS`
      match the real mainnet parent, and `PARENT_OUTPOINT` is the genuine
      funding UTXO (checked once, then the store tracks it).
- [ ] DNS + edge: `mint.degent.club`, `studio.degent.club`,
      `degent.club` resolve to the fleet's mainnet containers (see
      `docs/fleet-handoff.md` -- this is infra's side, tracked on its own
      Jira ticket, not done from this repo).
- [ ] Publish weekly counts from the certificate (`block.space` /
      `blockspace-certify`) once the first wave is live, per the phase's exit
      criterion.
