# @bsh/degent-web — the degent.club mint

The automated, non-custodial mint front end for the Decentralized Gentlemen Club (ADR-0002, amended by
[ADR-0005](../../../../docs/adr/0005-strict-reveal-and-tiers.md): 0x81 reveals, user-held rescue key, three tiers).
**What you see is what lands on chain:** the preview is rendered from the exact bytes that go into the
envelope, the SHA-256 is shown before upload and re-checked against ord after confirmation, and the
commit address is recomputed in the browser with `@bsh/inscription` before anything is payable.

```bash
pnpm --filter @bsh/degent-web dev        # http://localhost:5173  (add ?demo=1 for the full simulated flow)
pnpm --filter @bsh/degent-web test       # vitest + testing-library (jsdom)
pnpm --filter @bsh/degent-web typecheck
pnpm --filter @bsh/degent-web build      # → dist/
pnpm --filter @bsh/degent-web e2e        # build + real headless Chromium, ?demo=1 at 1280 and 400 px, screenshots
```

## Flow

```
 Welcome ─► Connect ─► Create ─► Validate ─► Quote ─► Pay ───────────────────────► Track
 3 tiers,   wallet-kit  tier,     mint-sdk    fee rate  1 Prepare                     poll GET /v1/orders/{id}
 live fees  ordinals vs exact     rules       breakdown   UTXOs (esplora)             ADR state timeline + tx links
 & queue    payment;    bytes,    locally,    tier+lane,  funding PSBT + txid         verified → ord /content
            legacy      compress  then PUT    block slot  half-signed reveal 0x81     side-by-side + "hash match ✓"
            refused     to tier,  content →   ETA,        (parent return signed)      rescue_available → GET /rescue
                        weight →  art review  expiry,     POST /reveal                inputs, re-sign [commit]→[child]
                        LANE      (approved?) commit addr save bundle WITH K_e        with K_e from the bundle,
                        shown                 VERIFIED?   wipe K_e from memory        broadcast
                                                        2 Sign (wallet) → txid check
   ▲                                                      → broadcast
   └── on load: recovery bundle found in localStorage → "Resume tracking"
```

The wizard is a pure reducer (`src/flow/reducer.ts`) with an entry guard per step (`canEnter`): no Quote
without an approved review, no Pay without a verified commit address and a live quote, no going back once
money may have moved. Side effects live in `src/flow/effects.ts` and are written against ports so their
**order** is tested.

### The money path (ADR-0002 §2), in order

1. `openOrder` — generate the ephemeral key `K_e` (in-memory `KeyVault`, never in React state), `POST /v1/orders`
   with only its x-only pubkey, keep the returned `orderToken` in memory, `PUT` the exact bytes (bearer token),
   wait for the art review.
2. `verifyCommit` — `@bsh/inscription.commitAddress(K_e.pub, bytes, parent, network)` must equal the service's
   **binding** quote. Mismatch or indicative quote → Pay is disabled.
3. `preparePayment` — fetch payment UTXOs (esplora), build the funding PSBT (commit output at vout 0, service
   fee if > 0, change) and compute its txid from the unsigned tx (nested-SegWit scriptSigs included),
   `buildHalfSignedReveal` with **SIGHASH_ALL|ANYONECANPAY (0x81)** over `[parent return, child]`, where the
   parent return is `collectionAddress` + `parentValueSats` from `GET /v1/config` (refuses to build without
   them), `POST /reveal`, **save the recovery bundle (with K_e)**, **wipe `K_e` from tab memory**.
4. The bundle is shown as copyable JSON (no download links) with a privacy warning; the user confirms they
   kept a copy.
5. `signAndBroadcast` — the wallet signs **without** broadcasting; we finalize, check the txid equals the one
   the reveal was signed against (a wallet that edits the tx would otherwise strand the funds), then broadcast
   via the wallet's `pushTx` or esplora `POST /tx`.

The wallet is never asked to sign before steps 3's reveal upload and recovery save have completed.

### Recovery bundle (v2, ADR-0005 §2)

`localStorage["degent.club/recovery/v2"]`: order id, network, API URL, funding txid/vout, commit value,
recipient, postage, content type + SHA-256 + **the exact bytes (base64)**, parent id, collection address and
parent value, the **one-time reveal key `revealPrivkey` (K_e, hex)** and its pubkey, and the **order token**.
It is shown as copyable JSON (no download link) before the wallet signs, with a note: the key controls only
the user's own commit output, and only into their ordinals address through the inscription script; keep it
private; it lets you rescue without us. v1 bundles (0x83 era) are not loaded.

Rescue (`rescue_available`, `flow/effects.ts#rescue`): `GET /rescue` with the token returns **inputs**, which
must match the bundle field by field (else refuse); the browser re-signs `[commit] → [child]` with K_e
(`@bsh/inscription.buildResignedRescue`) and broadcasts via wallet `pushTx` or esplora. Service unreachable →
the bundle alone is enough. No bundle on this device → Track asks the user to paste it; without it there is
no key and no rescue.

### Tiers and lanes (ADR-0005 §3)

Create offers **Standard Degent** (200-400 KB), **Large Degent** (400 KB-3.5 MB) and **Full Block Degent**
(3.5-3.9 MB). As soon as the bytes fit a tier, Create shows the exact reveal weight and its lane
(`laneForArtwork`: `@bsh/inscription.estimateRevealWeight` → `laneForWeight`); a 397-400 KB Standard Degent
gets a "travels the block lane" warning there and again on Quote. Quote shows tier, lane, block slot and ETA
(slot × ~10 min); Large and Full Block Degents get their own cost warnings.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_MINT_API_URL` | `/api` | Mint service base URL (`/v1/...` is appended) |
| `VITE_NETWORK` | `mainnet` | `mainnet` \| `testnet` (testnet4) \| `signet` \| `regtest` |
| `VITE_ESPLORA_URL` | mempool.space per network | Esplora-compatible API for UTXOs and broadcast |
| `VITE_EXPLORER_URL` | `https://explore.block.space` | Block explorer for tx links (`/tx/<txid>`) |
| `VITE_ORD_URL` | `https://ordinals.com` | ord server for `/content/<inscription id>` |
| `VITE_POLL_MS` | `5000` (`1200` in demo) | Order polling interval |

## Demo mode

Open the app with **`?demo=1`**. A striped **DEMO** ribbon is always visible. Wallet, mint service, chain and
inscription maths are fakes (`src/services/fakes.ts`); image compression uses the real canvas, and a
"Use a sample gentleman" button draws placeholder art. The fake wallet holds real keys and really signs the
funding PSBT with `@scure/btc-signer`, so the txid safety check runs for real. No bitcoin moves.

## Code map

| Path | What |
|---|---|
| `src/services/types.ts` | Ports: `MintApi`, `WalletService`, `ChainApi`, `InscriptionOps`, `ImageTools` |
| `src/services/real/*` | Adapters: `@bsh/degent-mint-sdk` client, `@bsh/wallet-kit`, esplora/ord, `@bsh/inscription`, canvas |
| `src/services/fakes.ts` | Fakes for tests and `?demo=1` (scenarios: happy, rescue, reject; tamper switches) |
| `src/flow/` | State, reducer, key vault, effect sequences, React context |
| `src/lib/` | Pure helpers: compression search, funding PSBT/coin selection, rules, recovery, timeline, format |
| `src/screens/` | One component per step |

Local rules delegate to `@bsh/degent-mint-sdk` (`validateContentMeta`, `sniffContentType`, `readImageInfo`)
with the service's own config; the app adds byte-level checks (magic bytes, length, SHA-256).

## Tests

`vitest` + `@testing-library/react` in jsdom, fakes only — nothing touches a network.

- `src/flow/reducer.test.ts` — every transition and guard.
- `src/lib/compression.test.ts` — byte-range search with a mocked canvas encoder (fit, too-small, downscale, too-large).
- `src/lib/funding.test.ts` — coin selection, dust, inscription guard, legacy refusal; precomputed txid equals the
  signed tx id for P2WPKH, P2SH-P2WPKH and P2TR payment addresses.
- `test/payment.test.ts` — **call order**: reveal POSTed and recovery saved (with K_e, matching the order's
  pubkey) and `K_e` wiped from memory before `wallet.signPsbt`; the 0x81 reveal's outputs are exactly
  [collection address + parent value, recipient + postage]; no wallet call when the reveal upload fails or
  the config lacks parent facts; altered funding tx is never broadcast; order-token handling; commit
  verification; rescue: inputs fetched then re-signed with K_e, bundle-only when the service is gone,
  wallet relay, refusal on input/bundle mismatch or wrong bytes, 409 before `rescue_available`, no bundle → no rescue.
- `test/create.test.tsx` — tier selection table (three tiers: label, byte range, lane, sharing) and the
  lane message for 397 / 398.5 / 400 KB Standard Degents (block lane) vs 300 KB (standard lane).
- `test/rules.test.tsx`, `test/quote.test.tsx` — rules display, review results, quote rendering (sats + BTC),
  commit-address mismatch blocking, Large / Full Block warnings, the ~398 KB Standard Degent quoted on the
  block lane, fee clamping and re-quote.
- `test/track.test.tsx` — timeline for every ADR status, delivered + hash match, rescue, resume from localStorage.
- `test/demo.e2e.test.tsx` — the whole flow through the UI in demo mode (jsdom).
- `e2e/demo.e2e.mjs` (`pnpm --filter @bsh/degent-web e2e`) — **real headless Chromium** via `playwright-core`
  (no bundled browsers: `CHROMIUM_PATH`, default `/opt/pw-browsers/chromium`, a binary or a directory to
  search). Builds, serves `vite preview` on a free port, drives `?demo=1` through all eight screens (welcome,
  connect, create with the real canvas encoder, validate, quote, pay, track, delivered) at 1280 px and 400 px,
  and fails on any console error, page error, horizontal page overflow or clipped progress nav. Google Fonts
  are stubbed for a hermetic run (system-font fallback in the renders). Screenshots:
  [`docs/screenshots/`](docs/screenshots) (`1280-01-welcome.png` … `400-08-delivered.png`).

Defects found by the first real renders and fixed: the page backdrop used `background-attachment: fixed`
on `body`, which painted a viewport-high band with hard edges on long pages (now a fixed `body::before`
layer over a solid `html` background); the progress nav clipped step 7 at 400 px; the segmented "bytes to
inscribe" control broke its pill shape when it wrapped at 400 px; shortened addresses on Pay split at the
ellipsis at 400 px; the footer still said the reveal key never leaves the tab.

## Accessibility & design

Dark "private members' club" identity: lacquered bottle green, brass, ivory; Cormorant Garamond display,
Manrope UI, JetBrains Mono (tabular) for sats, bytes and hashes. Every control is labelled and keyboard
operable, focus moves to each step's heading, status changes are announced (`aria-live`), motion honours
`prefers-reduced-motion`, and the layout works down to 360–400 px.
