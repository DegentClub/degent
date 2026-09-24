# Security

Threat model, controls and residual risks of degent.club (this repository). Findings are machine-readable in
[`security/findings.json`](security/findings.json) (schema `schemas/security-findings.schema.json`, checked by
`test/security-findings.test.ts`); open and accepted ones are tracked in `roadmap.yaml` (p0.20–p0.27).
Last review: 2026-09-24.

## Reporting a vulnerability

Contact: **TODO(owner)** (a monitored address and, ideally, a PGP key or a private GitHub security advisory
channel on DegentClub/degent). Until then, do not open public issues for vulnerabilities; contact the club owner
privately. We ask for 90 days before disclosure; money-path issues (anything that can move a user's BTC or
inscription) are fixed first.

## Scope and assumptions

- The product moves real bitcoin. The design goal is **non-custodial**: no service holds a key that can move a
  user's funds (ADR-0002, ADR-0005). Buys on the marketplace are off (`BUYS_ENABLED=false`, ADR-0008).
- The parent/child design (parent inscription, parent key, policy signer, `attachParent`, 0x81 half-signed
  parent reveals) is being removed (ADR-0010): the collector's browser will sign the full reveal and membership
  becomes member approval recorded in the Register. Findings on that path are marked `superseded`.
- The platform (`deps/scribbit`: `@bsh/inscription`, `@bsh/identity`, `@bsh/notify`, …) is reviewed here only as
  used; defects in it are reported as `platform` findings for DegentClub/scribbit.
- Attackers considered: anonymous internet clients (any number of IPs), a holder of one Degent, a collector
  paying for a mint, a hostile or compromised mint API as seen by the browser (or a network attacker between
  them), a host user on the deploy machine, whoever obtains a backup copy, and a malicious dependency.

## Components

### Mint service (`products/degent/services/mint`)

**Trust boundaries.** Public HTTP API behind the Caddy site (`/api/*`, same origin); the worker talks to esplora,
ord, the lane broadcasters and (today) the policy signer; sqlite (orders, votes, nonces, subscriptions, encrypted
half-signed reveals) and the content store on the same host; holder sessions are EdDSA tokens (`SESSION_KEY`).

**Attacker capabilities.** Create orders and upload bytes; hold the bearer order token of their own orders;
sign in with SIWB as any address they control; vote as a holder; call every public read endpoint; choose
request headers; race requests.

**Controls.**
- Order tokens: 256-bit random, stored as SHA-256, compared in constant time; checked before a 4 MiB upload is
  read; never logged. Order ids are 96-bit random (`dgt_…`), path-validated.
- Uploads: `bodyLimit` per route (16 KiB JSON, 4 MiB content, 8 MiB reveal), exact length + SHA-256 against the
  order, magic-byte sniffing and header-only dimension parsing (no pixel decoding server-side), review before any
  transition.
- SIWB via `@bsh/identity`: canonical message grammar, domain binding (`SIWB_DOMAIN`), network check, expiry, a
  single-use nonce consumed only after the signature verifies (sqlite `UPDATE … WHERE used_at IS NULL`).
- Votes: BIP-322 signature of an exact statement rebuilt by the service; one vote per canonical address and one
  per Degent (unique keys in both stores); holdings re-checked on every request; no self-votes (canonical
  address); votes on one order serialised; verdict from stored votes; Degent numbers from an atomic counter
  (DGT-SEC-001..004).
- Register: bounded upstream fan-out (≤ 1,000 UTXOs per holder lookup, coalesced lookups, ≤ 16 ord requests in
  flight; DGT-SEC-005); `limit ≤ 200`; query strings length-capped; no user-controlled regex.
- Rate limits: per client on POST/PUT, keyed on `X-Client-IP` set by Caddy from `{client_ip}` (right-to-left XFF,
  `trusted_proxies_strict`), never the client-supplied XFF hop (DGT-SEC-007).
- SQL: node:sqlite prepared statements only; `IN (?, …)` lists are built from counts, never from values.
- SSRF: every upstream URL comes from configuration; user-influenced path parts (txids, ids, addresses) are
  validated and `encodeURIComponent`-ed.
- Errors: domain errors are structured; anything else is `500 internal` with the detail only in the log. Logs are
  JSON lines (no header/log injection); tokens, PSBTs, keys, passphrases and bundles are never logged.
- Secrets as files (`*_FILE`, Docker secrets, systemd `LoadCredential`); dev keys refused off regtest; process
  umask 077 (DGT-SEC-008).

**Residual risks.** Public reads are limited only at the edge (DGT-SEC-011); paid vision review per upload
(DGT-SEC-012); order status and recipient are public by id (DGT-SEC-021); notification targets are arbitrary
(DGT-SEC-022); uploads buffered in memory (DGT-SEC-023). Parent path (superseded by ADR-0010): lease release on
timeout (DGT-SEC-030), unsigned parent input value (DGT-SEC-031), policy-signer checks (DGT-SEC-032), no KMS signer
(DGT-SEC-033).

### Web app (`products/degent/apps/web`)

**Trust boundaries.** The browser is the only place K_e exists in plaintext; the mint API, esplora and ord are
remote and untrusted for anything the browser signs or pays; wallets are extensions.

**Attacker capabilities.** A hostile or compromised mint API (or MITM) returning forged orders and quotes;
crafted inscription content shown in the explorer/lightbox; a crafted recovery bundle file; links to the site
with crafted paths and query strings; framing.

**Controls.**
- The payment is built only from what the browser derives: the reveal pubkey comes from the key in the tab, the
  commit address is recomputed, the recipient must be the wallet's ordinals address, the content hash must match
  the artwork, the parent return must be the published collection address (DGT-SEC-006); the wallet is asked to
  sign only after the reveal is stored and the recovery bundle saved; the funding txid is re-checked.
- Recovery bundle: K_e encrypted with AES-256-GCM under PBKDF2-SHA256 (600,000 iterations, 16-byte salt, 12-byte
  IV), AAD = order id + reveal pubkey; iteration count bounded on decrypt (DGT-SEC-010); plaintext K_e wiped after
  use; the passphrase is never stored or sent. Rescue parameters from the service are compared with the bundle.
- Rendering: React escapes all text; inscription content is shown only through `<img>` (SVG in `<img>` runs no
  script); no `dangerouslySetInnerHTML`; external links `rel="noopener noreferrer"`.
- Headers (Caddy): CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'none';
  base-uri 'none'; object-src 'none'`, HSTS, `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`,
  COOP/CORP, Permissions-Policy. Holder sessions are kept in memory only.
- Order ids used in API paths cannot be dot-segments (DGT-SEC-009).

**Residual risks.** Passphrase strength (DGT-SEC-013); bundle AAD does not cover rescue parameters
(DGT-SEC-014); order token and encrypted K_e in localStorage (DGT-SEC-015); `style-src 'unsafe-inline'`
(DGT-SEC-016).

### Market service and SDK (`services/market`, `packages/market-sdk`)

**Trust boundaries.** Public API; sellers' 0x83 signatures stored while listings are open; the mint's Register
(membership), ord and esplora (validity); buyers' wallets.

**Controls.** Buys behind `BUYS_ENABLED=false` at the HTTP layer and in the service; listing/cancel require a
SIWB challenge whose Request ID binds action, inscription and price (legacy signatures disabled); zod schemas
with unknown fields rejected; the seller's template is rebuilt byte-for-byte and the signature verified
cryptographically; the FIFO destination (`@bsh/inscription`) is asserted before a buy PSBT is returned and again
on the exact raw bytes before broadcast; buyer PSBTs must equal the service's unsigned transaction; royalty dust
refused at listing; buy sessions single-use.

**Residual risks.** Double-sell race until buys are enabled (DGT-SEC-017); buyer-UTXO lookups uncapped
(DGT-SEC-018); a leaked database lets anyone complete an open listing at its price (ADR-0008).

### Telegram gate (`services/telegram-gate`)

**Controls.** One-time `/verify` links (HMAC-SHA256, 10-minute expiry, single-use jti); the SIWB statement names
the Telegram user id and is checked before any nonce is consumed; one wallet ↔ one active Telegram account;
invites are single-use, expire in 10 minutes and travel only by DM; periodic re-verification kicks members who
sold; a Register outage never kicks anyone; operator stats behind an operator SIWB session (`ADMIN_ADDRESSES`).

**Residual risks.** A Degent can admit accounts in turn between re-verification runs (DGT-SEC-019).

### X bot (`services/x-bot`)

**Controls.** Every text passes `gateContent` (tier classifier, address filter, banned phrases, length); posting
alone only for `auto` tier with `REVIEW_QUEUE_ENABLED=false` and `POSTING_ENABLED=true`; the token is never
logged or echoed. Drafts come only from Register facts.

### Deploy (`products/degent/deploy`, `flake.nix`)

**Controls.** Images run as non-root with read-only root filesystems, `cap_drop: ALL`, `no-new-privileges`; only
the web port is published (loopback by default); no secrets in images, compose or env examples (Docker secrets /
systemd credentials; mainnet has no defaults for anything secret); the NixOS units are hardened (`UMask=0077`,
`ProtectSystem=strict`, `NoNewPrivileges`). Backups are private (umask 077) and, with `BACKUP_AGE_RECIPIENT`
(required on mainnet), age-encrypted before they are written (DGT-SEC-008).

**Residual risks.** Actions pinned by tag (DGT-SEC-020).

## Supply chain

- `pnpm install --frozen-lockfile` in CI and images; the lockfile carries integrity hashes; only `esbuild` may run
  install scripts (`pnpm.onlyBuiltDependencies`).
- `pnpm audit --prod` (2026-09-24): **no known vulnerabilities**. CI runs `pnpm audit:prod` (high/critical fail).
- `pnpm test:secrets` (`scripts/secret-scan.mjs`) scans every blob in the git history and the working tree for
  private keys (PEM, WIF, xprv, hex keys by name), labelled seed phrases, age keys, AWS keys, Telegram bot tokens,
  JWTs, vendor API keys and tracked `.env` files; the allowlist matches path AND the value's SHA-256. It runs in
  CI and in `pnpm check`. Result at this review: 0 findings.

## Platform findings (for DegentClub/scribbit)

DGT-SEC-040 (`@bsh/identity` accepts upper-case bech32; sessions are not canonical), DGT-SEC-041
(`InMemoryNonceStore` sweeps on the wall clock), DGT-SEC-042 (legacy signmessage accepted by default). Tracked as
roadmap p0.26.

## Findings

| id | component | severity | status |
|---|---|---|---|
| DGT-SEC-001 | mint | high | fixed |
| DGT-SEC-002 | mint | high | fixed |
| DGT-SEC-003 | mint | medium | fixed |
| DGT-SEC-004 | mint | medium | fixed |
| DGT-SEC-005 | mint | medium | fixed |
| DGT-SEC-006 | web | high | fixed |
| DGT-SEC-007 | mint, market, gate, deploy | medium | fixed |
| DGT-SEC-008 | deploy | medium | fixed |
| DGT-SEC-009 | mint-sdk | low | fixed |
| DGT-SEC-010 | web | low | fixed |
| DGT-SEC-011 | mint | low | open (p0.21) |
| DGT-SEC-012 | mint | low | open (p0.22) |
| DGT-SEC-013 | web | low | open (p0.23) |
| DGT-SEC-014 | web | low | accepted (p0.23) |
| DGT-SEC-015 | web | low | accepted (p0.23) |
| DGT-SEC-016 | deploy | low | accepted (p0.24) |
| DGT-SEC-017 | market | low | open (p0.25) |
| DGT-SEC-018 | market | low | open (p0.25) |
| DGT-SEC-019 | telegram-gate | low | accepted (p0.24) |
| DGT-SEC-020 | deploy | low | open (p0.24) |
| DGT-SEC-021 | mint | low | accepted (p0.24) |
| DGT-SEC-022 | mint | low | accepted (p0.24) |
| DGT-SEC-023 | mint | low | accepted (p0.24) |
| DGT-SEC-030 | mint (parent path) | medium | superseded (ADR-0010) |
| DGT-SEC-031 | mint (parent path) | medium | superseded (ADR-0010) |
| DGT-SEC-032 | mint (policy signer) | low | superseded (ADR-0010) |
| DGT-SEC-033 | mint (policy signer) | medium | superseded (ADR-0010) |
| DGT-SEC-040 | platform | medium | platform (p0.26) |
| DGT-SEC-041 | platform | low | platform (p0.26) |
| DGT-SEC-042 | platform | low | platform (p0.26) |

Titles, tests and commits: [`security/findings.json`](security/findings.json).
