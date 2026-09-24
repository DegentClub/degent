# @bsh/degent-web — the degent.club mint

The automated, non-custodial mint front end for the Decentralized Gentlemen Club (ADR-0002, amended by
[ADR-0005](../../../../docs/adr/0005-strict-reveal-and-tiers.md): 0x81 reveals, user-held rescue key, three tiers).
**What you see is what lands on chain:** the preview is rendered from the exact bytes that go into the
envelope, the SHA-256 is shown before upload and re-checked against ord after confirmation, and the
commit address is recomputed in the browser with `@bsh/inscription` before anything is payable.

Since [ADR-0007](../../../../docs/adr/0007-open-studio.md) (the Open Studio) the app is also the **gallery** of
artist-hung Degents and the **Artist Studio**: sign in with Bitcoin, prove a payout address with BIP-322, hang
a piece, watch the review, see your royalties. Minting a gallery piece pays its artist as **output [1] of the
funding transaction** the minter signs — never through us, never in the reveal.

```bash
pnpm --filter @bsh/degent-web dev        # http://localhost:5173  (add ?demo=1 for the full simulated flow)
pnpm --filter @bsh/degent-web test       # vitest + testing-library (jsdom)
pnpm --filter @bsh/degent-web typecheck
pnpm --filter @bsh/degent-web build      # → dist/
pnpm --filter @bsh/degent-web e2e        # build + real headless Chromium, ?demo=1 at 1280 and 400 px, screenshots
```

## Routes (hash router, `src/lib/router.ts`, no router library)

| Hash | Screen |
|---|---|
| `#/`, `#/mint` | The mint wizard below (Welcome → … → Track) |
| `#/mint/:artworkId` | The wizard with a studio Degent prefilled (Create skips upload/compress and shows the piece) |
| `#/gallery`, `#/gallery?page=n&artist=addr` | Gallery of approved artworks (`GET /v1/artworks?status=approved`, featured first), paged |
| `#/gallery/:id` | One artwork: image from the content endpoint, artist link, edition count when supplied, the five Degent rules, **Mint this Degent** |
| `#/studio` | Artist Studio: connect, Sign in with Bitcoin, profile, payout proof, your artworks (status pills, delist) |
| `#/studio/upload` | Hang a Degent: declare → `PUT` the exact bytes → verdict (approved / rejected with reasons / *waiting for the house*) |
| `#/studio/royalties` | Royalty records (funding `txid:vout` links to the explorer) and totals |

`useRoute()` subscribes to `hashchange`; `navigate()` sets the hash. `<Link to>` renders a real `<a href="#/…">`.

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
3. `preparePayment` — fetch payment UTXOs (esplora), build the funding PSBT (**[0] commit, [1] artist royalty
   when minting a studio Degent, [2] club / service fee, [3] change**; an output is omitted only when its value
   is 0, a royalty below the payout script's dust limit is raised to it and the Pay screen says so) and compute
   its txid from the unsigned tx (nested-SegWit scriptSigs included),
   `buildHalfSignedReveal` with **SIGHASH_ALL|ANYONECANPAY (0x81)** over `[parent return, child]`, where the
   parent return is `collectionAddress` + `parentValueSats` from `GET /v1/config` (refuses to build without
   them), `POST /reveal`, **save the recovery bundle (with K_e)**, **wipe `K_e` from tab memory**.
4. The bundle is shown as copyable JSON (no download links) with a privacy warning; the user confirms they
   kept a copy.
5. `signAndBroadcast` — the wallet signs **without** broadcasting; we finalize, check **every output's script
   and value** against the PSBT we built (`FundingOutputsMismatchError`, naming the output) and then the txid
   against the one the reveal was signed against (`FundingTxidMismatchError`; a wallet that edits the tx would
   otherwise strand the funds or short the artist), then broadcast via the wallet's `pushTx` or esplora `POST /tx`.

The wallet is never asked to sign before steps 3's reveal upload and recovery save have completed.

### Recovery bundle (v2, ADR-0005 §2)

`localStorage["degent.club/recovery/v2"]`: order id, network, API URL, funding txid/vout, commit value,
recipient, postage, content type + SHA-256 + **the exact bytes (base64)**, parent id, collection address and
parent value, the **one-time reveal key `revealPrivkey` (K_e, hex)** and its pubkey, the **order token**, and,
for a studio Degent, `artworkId` and the reserved `edition` (optional; older v2 bundles without them still load).
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

### Studio Degents in the wizard (ADR-0007 §5, plan §3)

`#/gallery/:id` → **Mint this Degent** → `#/mint/:id`. Create fetches the exact bytes from
`GET /v1/artworks/{id}/content`, checks their SHA-256 against the artwork record, picks the tier by size and
skips the upload/compress tools and the brief (the studio reviewed the piece when the artist hung it).
`openOrder` sends `artworkId` on `POST /v1/orders`; when the service answers `approved` with a binding quote the
content upload is skipped, otherwise the bytes are uploaded as for any Degent. Quote shows **four lines** when
the quote carries `clubFeeSats` / `artistRoyaltySats`: network cost, club fee, artist royalty (with the artist's
payout address), total. Track shows **Artist paid** with `txid:vout` once the order carries `royaltyPaid`. All of
these mint-contract fields are read as optional (`src/services/types.ts`: `artworkQuote`, `royaltyPaidOf`).

## Artist Studio (`src/services/studioApi.ts`, `src/flow/studio.tsx`, `src/screens/Studio*.tsx`)

The studio is a service ([contract](../../../../contracts/openapi/degent-studio.yaml)), not a library: the app
talks to it through the small typed client `services/studioApi.ts` (`StudioApi` port; fake in `services/fakes.ts`).

1. **Sign in with Bitcoin** — `POST /v1/auth/challenge` for the wallet's ordinals address → the wallet signs the
   SIWB message (`signMessage`, BIP-322 simple) → `POST /v1/auth/verify` → session JWT, kept in React state and
   mirrored to `sessionStorage["degent.club/studio/session/v1"]` (try/catch; a stored session is re-checked with
   `GET /v1/artists/me` on load and dropped if stale). Never in a URL.
2. **Payout address, proven not declared** — pick the ordinals or the payment address; the wallet signs the fixed
   text `degent.club payout address <address> for <sessionSub>` with *that* address and `PUT /v1/artists/me`
   stores it. Legacy (P2PKH / P2SH) addresses are refused before the wallet is asked, with an explanation
   (`LegacyPayoutError`): they cannot produce BIP-322 simple signatures and would bloat the minter's funding tx.
3. **Hang a Degent** — `POST /v1/artworks` (title, description, type, length; one-time upload token) →
   `PUT /v1/artworks/{id}/content` (exact bytes; the review runs once, there). Verdicts: **Hanging** (approved),
   **Rejected** with reasons and checks, or **Waiting for the house** (`reviewing` + `needsHuman`: a skipped check
   never approves; the page polls until the house decides).
4. **Your Degents** — every status with a pill; approved pieces can be **delisted**.
5. **Royalties** — `GET /v1/artists/me/royalties`: records with funding `txid:vout` explorer links, and totals.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_MINT_API_URL` | `/api` | Mint service base URL (`/v1/...` is appended) |
| `VITE_STUDIO_API_URL` | `/studio` | Artist Studio base URL (`/v1/...` is appended) |
| `VITE_GALLERY_PAGE_SIZE` | `12` | Artworks per gallery page |
| `VITE_NETWORK` | `mainnet` | `mainnet` \| `testnet` (testnet4) \| `signet` \| `regtest` |
| `VITE_ESPLORA_URL` | mempool.space per network | Esplora-compatible API for UTXOs and broadcast |
| `VITE_EXPLORER_URL` | `https://explore.block.space` | Block explorer for tx links (`/tx/<txid>`) |
| `VITE_ORD_URL` | `https://ordinals.com` | ord server for `/content/<inscription id>` |
| `VITE_POLL_MS` | `5000` (`1200` in demo) | Order polling interval |

## Demo mode

Open the app with **`?demo=1`**. A striped **DEMO** ribbon is always visible. Wallet, mint service, studio, chain
and inscription maths are fakes (`src/services/fakes.ts`); image compression uses the real canvas, and a
"Use a sample gentleman" button draws placeholder art. The fake wallet holds real keys and really signs the
funding PSBT with `@scure/btc-signer`, so the txid / output safety checks run for real. The fake studio seeds
three approved artworks by two artists (real 500×500 greyscale PNGs of ~250 KB generated in code, served as data
URLs; one featured), accepts uploads with a configurable verdict (`approve` / `reject` / `needsHuman`), and its
`signMessage` "signatures" are a deterministic function of address + message that only the fake studio accepts.
Minting a demo gallery piece pays 10% of a simulated mint price to the artist as output [1] and records it in
the fake studio's royalty ledger. No bitcoin moves.

## Code map

| Path | What |
|---|---|
| `src/services/types.ts` | Ports: `MintApi`, `StudioApi`, `WalletService` (+ `signMessage`), `ChainApi`, `InscriptionOps`, `ImageTools`; optional studio fields of quotes/orders read defensively |
| `src/services/studioApi.ts` | Typed client for the studio contract (`createStudioApi`, `StudioApiError`) |
| `src/services/real/*` | Adapters: `@bsh/degent-mint-sdk` client, `@bsh/wallet-kit`, esplora/ord, `@bsh/inscription`, canvas |
| `src/services/fakes.ts` | Fakes for tests and `?demo=1` (scenarios: happy, rescue, reject; tamper switches; fake studio + generated gallery PNGs) |
| `src/flow/` | State, reducer, key vault, effect sequences, React context; `studio.tsx` = the artist session |
| `src/lib/` | Pure helpers: hash router, compression search, funding PSBT/coin selection, rules, recovery, studio session, timeline, format |
| `src/screens/` | One component per mint step, plus `Gallery`, `Artwork`, `Studio`, `StudioUpload`, `StudioRoyalties` |
| `src/components/` | Chrome and UI: header with site nav, `Frame` (gold frame + plaque), `RulesPills`, `Link` |

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
- `test/track.test.tsx` — timeline for every ADR status, delivered + hash match, rescue, resume from localStorage,
  "Artist paid" with `txid:vout` when the order carries `royaltyPaid`.
- `test/router.test.ts` — every route parses and round-trips; `useRoute` follows `navigate()` and `hashchange`.
- `test/gallery.test.tsx` — gallery renders from the fake (frames, DEGENT plaques, short artist addresses, featured
  first), paging, artist filter; artwork page (image, artist link, five rule pills, edition count, SHA-256),
  "Mint this Degent" prefill, shared `#/mint/:id` links, 404s.
- `test/artworkMint.test.tsx` — the wizard with an artwork: Create skips upload/compress, Quote's four lines with
  the artist address, Pay's outputs `[commit, artist royalty, club fee, change]`, bundle with `artworkId`/`edition`,
  Track's "Artist paid" `txid:1`, the studio ledger receiving the record.
- `test/studio.test.tsx` — sign-in round trip (challenge → `wallet.signMessage` → verify), session persistence and
  restore, sign-out, display name; payout proof with the taproot and the SegWit address, legacy refusal (UI and
  API: `payout_address_legacy`, `payout_proof_invalid`); upload flow: approved, rejected with reasons,
  `needsHuman` → "Waiting for the house" → resolved by polling, byte-rule failure blocks submit; artworks list with
  status pills and delist; royalties totals and explorer links.
- `src/lib/funding.test.ts` also covers the royalty target at [1], omission at 0, dust raise, `compareOutputs`;
  `test/payment.test.ts` the output-value tamper refusal and the studio-artwork money path;
  `src/lib/recovery.test.ts` the optional `artworkId`/`edition`.
- `test/demo.e2e.test.tsx` — the whole flow through the UI in demo mode (jsdom).
- `e2e/demo.e2e.mjs` (`pnpm --filter @bsh/degent-web e2e`) — **real headless Chromium** via `playwright-core`
  (no bundled browsers: `CHROMIUM_PATH`, default `/opt/pw-browsers/chromium`, a binary or a directory to
  search). Builds, serves `vite preview` on a free port, drives `?demo=1` through all eight screens (welcome,
  connect, create with the real canvas encoder, validate, quote, pay, track, delivered) at 1280 px and 400 px,
  then visits the gallery, an artwork page and the studio (signed in with the fake wallet), and fails on any
  console error, page error, horizontal page overflow or clipped progress nav. Google Fonts are stubbed for a
  hermetic run (system-font fallback in the renders). Screenshots: [`docs/screenshots/`](docs/screenshots)
  (`1280-01-welcome.png` … `400-08-delivered.png`, then `…-09-gallery.png`, `…-10-artwork.png`, `…-11-studio.png`).

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
