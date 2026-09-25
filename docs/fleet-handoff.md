# Fleet handoff: degent.club + block.space go-live

**Audience**: the infrastructure team (Scribbitt/infrastructure), not this repo's
own CI. **This is a document only** -- nothing in `/home/user/infrastructure` was
touched to produce it, and none of it should be implemented without its own
Jira ticket (INFRA, per that repo's Jira workflow rule) and going through
`fleet deploy tf` / `fleet deploy nixos apply` as usual. It exists so infra has
one place describing what application-side deploy work (this doc, `DEPLOY.md`
in this repo, `/home/user/scribbit/DEPLOY.md`, `/home/user/blockspace/DEPLOY.md`)
assumes the fleet will provide.

## What needs adding

### 1. Flake inputs

Three new/updated app-repo flake inputs, each providing (per
`nix/hosts/pve/*.nix`'s existing pattern for submodule app repos) a Nix package
+ NixOS module via that repo's own `flake.nix`:

- `degent` (DegentClub/degent) -- `mint`, `studio`, `atelier`, `web`.
- `scribbit` (DegentClub/scribbit) -- `mcp`, `mint-api`, `ledger`, `signer`,
  `plane`, `fee-oracle`. Note `degent` and `blockspace` already vendor
  `scribbit` as a *git submodule* (`deps/scribbit`, pinned) for their own pnpm
  workspace; the flake input is a separate, infra-side concern for running the
  platform services themselves as NixOS hosts.
- `blockspace` (DegentClub/blockspace) -- `certify`.

None of these exist as flake inputs today; the four repos build with pnpm +
Docker (see each repo's `DEPLOY.md`), not Nix -- these services have no `nix
run`/`nix build` entry point yet. **The Nix packaging (a `flake.nix` per repo
exposing each service as a package + NixOS module, matching the existing
submodule-app-repo pattern) is infra-side work this handoff flags but does not
do**; this repo's own deploy artifacts (Dockerfiles) are the interim path and
can run standalone (`podman`/`docker` under a NixOS `virtualisation.oci-containers`
stanza) if a full native Nix package isn't ready before signet game day.

### 2. NixOS module hosts (CT layout suggestion)

Following the estate's per-network-isolated-container convention
(`inscribe-counterparty` / `inscribe-counterparty-mainnet` /
`inscribe-counterparty-testnet` is the closest existing pattern: a stateless
frontend/ingress CT plus per-backend CTs, `nix/hosts/pve/inscribe-counterparty*.nix`).

A `vm_id` scan of `nix/hosts/pve/*.nix` at the time of writing shows
**200-205, 207, 213-221, 223-228, 232-235, 237-243, 250** occupied; this
repo's `CLAUDE.md` "Container Layout" table (`Apps 205-211: api/app/inscribe
mainnet+testnet`) does not match what is actually deployed there today (205 is
`dash`, 207 is `timescale-db`) -- treat that table as an aspirational naming
convention, not current occupancy, and re-confirm free numbers against the
live fleet manifest (`fleet dev services` / `fleet deploy tf list`) before
assigning, since this scan can't see terranix-only entries or any change since
it was taken.

Proposed (five consecutive free numbers found in the scan above):

| CT | Host | Service | Notes |
|---|---|---|---|
| 206 | `degent-mint` | `@bsh/degent-mint` | Non-custodial; talks to `signer` over the private network only. |
| 208 | `degent-studio` | `@bsh/degent-studio` | Artist SIWB sessions; needs `mint`'s `STUDIO_URL` reachable from CT 206. |
| 209 | `degent-atelier` | `@bsh/degent-atelier` | Stateless-ish (sqlite cost ledger); outbound to OpenAI if `ATELIER_MODE=openai`. |
| 210 | `degent-web` | `@bsh/degent-web` static build | Public-facing; see domain root note below. |
| 211 | `blockspace-certify` | `@bsh/blockspace-certify` | Public-facing (`certify.block.space`); needs an `ord` RPC/HTTP endpoint reachable. |

Each host: same `network_mode = "single-internal"`, `ssh_groups`,
`infra.auth.sssd`, `infra.komodo-periphery.enable`,
`infra.network.tailnet.fleetNode` boilerplate as every other app CT (see
`inscribe-counterparty-mainnet.nix` for the shape). `degent-mint`,
`degent-studio`, `degent-atelier` each need a `mount_points` entry (or a
`/data` tmpfs-backed dir is *not* appropriate -- these are the sqlite DB +
content-addressed blob dir, see each repo's `DEPLOY.md`) sized for
inscription content -- start around 20-50G each and watch `CONTENT_DIR`
growth; `degent-web` is stateless (no mount).

The platform services (`scribbit`'s `signer`, `ledger`, `plane`, `mcp`,
`mint-api`, `fee-oracle`) are **not** included in this table -- they are
shared across products (degent, blockspace's own product surface, and
whatever else calls them) and belong on their own CT block, sized by
whoever's already running them today if that's further along than this repo
assumes. `docs/fleet-handoff.md` only requests the CTs for what's new in this
change: the degent app tier + block.space certify. If `signer`/`ledger` do not
yet have fleet hosts, they need them **before** `degent-mint` can run with
`SIGNER=remote` off regtest -- see each service's `DEPLOY.md` for what they
need.

Existing shared resources to reuse, not duplicate:

- **RabbitMQ**: CT 207 is `rabbitmq` already per this repo's own `CLAUDE.md`.
  `degent-mint`'s `AMQP_URL` should point at it, not a new broker (this repo's
  `deploy/compose.signet.yml` starts its own RabbitMQ container only for a
  fully local/offline compose run -- point it at CT 207 instead once these
  hosts exist).
- **Fee data / libre-relay / slipstream lanes**: `degent-mint`'s
  `LIBRE_RPC_URL` / `SLIPSTREAM_URL` (block-lane broadcaster for Large / Full
  Block Degents, ADR-076 in the infra repo) need `degent-mint`'s CT to reach
  the `infra.chainGateway` endpoints (`rpc.<network>.libre.nodes`,
  see `nix/modules/chain-gateway/default.nix`) -- **mainnet only today**:
  `libre-mainnet` (CT 227) and `libre-testnet4` (CT 228) exist; there is no
  `libre-signet` host yet. Signet game day (`p5.6`) can run without one (mint
  falls back to the esplora broadcaster for the block lane on non-mainnet
  networks, by design), but **mainnet launch (`p6.3`) needs `degent-mint`'s CT
  to have network reach to the libre-mainnet gateway** (and/or a Slipstream
  API egress allowlist entry, since Slipstream is an external HTTPS API, not
  an internal `.nodes` endpoint) before it can mint a Full Block Degent.

### 3. DNS

| Domain | Points at | Notes |
|---|---|---|
| `mint.degent.club` | `degent-mint` (CT 206) | API only, no browser UI. |
| `studio.degent.club` | `degent-studio` (CT 208) | Artist-facing SIWB app; also the `SIWB_DOMAIN` value. |
| `degent.club` | `degent-web` (CT 210) | Public site + mint UI. **`flashy/public` must be served at this domain's root** (see below). |
| `block.space` | (existing block.space product host, out of scope here) | Public site. **`flashy/public` must be served at this domain's root** too. |
| `certify.block.space` | `blockspace-certify` (CT 211) | API only. |

Every new host needs the standard new-container DNS step this repo's infra
`CLAUDE.md` already documents: **redeploy `netcore`**
(`fleet deploy nixos apply host netcore`) after the CTs exist, so CoreDNS's
`.skrybit.pve` zone picks them up and internal ACME cert orders stop failing
`pending` -- this bit `sysadmin-server` before (INFRA-173) and will bite these
hosts the same way if skipped. The four public hostnames above are the
external (Caddy/`netcore` edge, or whatever fronts `degent.club`/`block.space`
today) records; they're separate from the internal `.skrybit.pve` names each
CT also gets.

**`flashy/public` at the domain root**: each of `degent`, `scribbit` and
`blockspace` carries a `flashy/public/` directory (FlashyOS "AAO"
accountability files -- `@bsh/mesh`, ADR-0010 in the platform's docs) with
generated `.well-known/*.json` files (`flashyos-charter.json`,
`flashyos.roles.json`, `frontdoor.json`, `directory.fragment.json`, etc.) that
must be reachable at `https://<domain>/.well-known/...` and
`https://<domain>/directory.fragment.json` for FlashyOS agents to verify who
answers for the organisation. **This is a static-file-serving requirement at
each domain's root** -- whatever fronts `degent.club` and `block.space` (the
`degent-web` container's own static server, or the fleet edge in front of it)
needs to also serve `flashy/public`'s contents at those paths, e.g. by
layering it into the same static root the app is served from, or a small edge
rule that path-routes `/.well-known/*` and `/directory.fragment.json` /
`/flashyos.roles.json` to a copy of `flashy/public` alongside the app's own
static assets. This repo's `deploy/docker/web.Dockerfile` does **not** do this
today (it only ships `apps/web`'s `vite build` output) -- infra or a follow-up
app-side change needs to decide where that copy step lives (baked into the
image at build time is simplest, since `flashy/public` is regenerated by
`pnpm mesh:emit` and checked into the repo already).

### 4. Reference pattern

`inscribe-counterparty` (CT 234, frontend/ingress-only, `nix/hosts/pve/inscribe-counterparty.nix`)
+ `inscribe-counterparty-mainnet`/`-testnet` (CT 225/224, per-network backends,
`nix/hosts/pve/inscribe-counterparty-mainnet.nix`) is the closest existing
shape to what `degent-web` + `degent-mint`/`degent-studio`/`degent-atelier`
need: a stateless static/ingress host separated from the stateful backend
hosts, each with its own CT so a network's backend can be redeployed, resized
or destroyed without touching the frontend. Unlike that pattern, degent has no
per-network duplication (mainnet vs. testnet) -- one CT per service is enough;
what *is* per-network is which URLs a given deploy's env points at (signet
staging vs. mainnet production use the same images, different `.env`, per each
repo's `DEPLOY.md`).

## What this repo already provides

- `deploy/docker/*.Dockerfile` for every service in this table (multi-stage,
  `node:22-slim`, non-root, `HEALTHCHECK`) -- see `DEPLOY.md` for how they're
  built and what was actually validated with `docker build` in this change.
  These can run as-is under `virtualisation.oci-containers` on any of the CTs
  above without waiting on the flake-input packaging in item 1.
- `deploy/compose.signet.yml` + `deploy/.env.example` -- the signet staging
  stack (app tier only; points at the fleet for `signer`/`ledger`/bitcoind).
- Health check paths and required secrets (by SOPS path, never value) for
  every service, in each repo's `DEPLOY.md`.
