# @bsh/degent-web — the degent.club site and mint

The full degent.club web app: the public site (home, the certified collection, mint process, comic, about,
manifesto, blog, artist pages) rebuilt per [`docs/site-spec.md`](../../docs/site-spec.md) (roadmap p6.1), plus
the automated, non-custodial mint (ADR-0002, amended by
[ADR-0005](../../../../docs/adr/0005-strict-reveal-and-tiers.md): 0x81 reveals, user-held rescue key, three tiers)
still at `#/mint`. **What you see is what lands on chain:** the preview is rendered from the exact bytes that go
into the envelope, the SHA-256 is shown before upload and re-checked against ord after confirmation, and the
commit address is recomputed in the browser with `@bsh/inscription` before anything is payable.

Since [ADR-0007](../../../../docs/adr/0007-open-studio.md) (the Open Studio) the app is also the **gallery** of
artist-hung Degents and the **Artist Studio**: sign in with Bitcoin, prove a payout address with BIP-322, hang
a piece (with an optional edition cap), watch the review, see your royalties, appeal a rejection and set a
notification webhook or Telegram chat ([ADR-0012](../../../../docs/adr/0012-edition-caps-curation-appeals.md)).
Minting a gallery piece pays its artist as **output [1] of the funding transaction** the minter signs — never
through us, never in the reveal.

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
| `#/` | **Home**: hero wall of certified Degents, the two live meters, the collection card (projected vs certified), the comic, the "Degen Minter" banner |
| `#/collection`, `#/collection?page=n&per=n` | **The Collection**: hero, collection card, the certified-member grid with the full pagination toolbar (per-page, page select, first/prev/…/next/last, "Go to") |
| `#/collection/:n` | …with `DEGENT #n`'s lightbox open (inscription id, address, content type/length, timestamp, block height, fee; prev/next, filmstrip) |
| `#/mint-process` | **Minting Rules**: the four rule cards from `DEGENT_RULES` (`@bsh/degent-mint-sdk`) and the "Did you know?" callout |
| `#/comic` | The comic (footer "Quick Links"; the wall/cover renders from `VITE_COMIC_INSCRIPTION_ID` when set) |
| `#/about`, `#/manifesto` | `TODO(copy)` placeholders — the live site's copy for these was never captured, so the rebuild does not invent it |
| `#/blog`, `#/blog/:slug` | **Degent Chronicles**: posts from `content/blog/*.md`, WordPress slugs kept |
| `#/artists/:address` | One artist, joining their studio profile, their certified members (`GET /v1/collections/{slug}/artists/{address}`) and their approved Studio artworks |
| `#/mint`, `#/`… | The mint wizard below (Welcome → … → Track) — the wizard's own home moved to `#/mint` with the site rebuild |
| `#/mint/:artworkId` | The wizard with a studio Degent prefilled (Create skips upload/compress and shows the piece) |
| `#/gallery`, `#/gallery?page=n&artist=addr&available=1\|0` | Gallery of approved artworks (`GET /v1/artworks?status=approved`, featured first), paged; `available` filters mintable vs sold-out (ADR-0012) |
| `#/gallery/:id` | One artwork: image from the content endpoint, artist link, edition count and sold-out state when supplied, the five Degent rules, **Mint this Degent** (disabled when sold out) |
| `#/studio` | Artist Studio: connect, Sign in with Bitcoin, profile, payout proof, notification settings, your artworks (status pills, edition-cap editor, appeal form, delist) |
| `#/studio/upload` | Hang a Degent: declare (with an optional edition cap) → `PUT` the exact bytes → verdict (approved / rejected with reasons / *waiting for the house*) |
| `#/studio/royalties` | Royalty records (funding `txid:vout` links to the explorer) and totals |

`useRoute()` subscribes to `hashchange`; `navigate()` sets the hash. `<Link to>` renders a real `<a href="#/…">`.

## The site (site rebuild, roadmap p6.1 + p4.3)

### Counts: one source, never hard-coded

The old degent.club site showed three conflicting counts (site vs `collection.json` vs an internal analysis).
The rebuild reads **one** source: the block.space certification attestation, `GET /v1/collections/{slug}`
(`src/services/certifyApi.ts`, config `VITE_CERTIFY_URL` + `VITE_COLLECTION_SLUG`, contract
`DegentClub/blockspace` → `blockspace-collections.yaml`, a service in another product — this file is the app's
whole knowledge of it). `src/lib/counts.ts#countsFrom` turns the attestation into `CollectionCounts` (certified
`minted` / `bytes`, `mintedPct` / `bytesPct` against `PROJECTED_TARGET` = `{ supply: 10_000, blockspaceBytes:
3_000_000_000 }`). Every number on the site carries an explicit `<Tag>`: **certified** (from the attestation, or
**demo data** under `?demo=1`) or **projected** (the published "10K = 3+ GB" target, shown as a target, never as
a fact). There is no hard-coded 4,027 / 1,470 anywhere in the app; `test/site.test.tsx` asserts those old numbers
never render. `src/flow/site.tsx`'s `SiteProvider` loads the certificate once and shares it (plus a lazily-paged
`MemberIndex` and an ord `DetailsCache`) with every page via `useSite()`.

### Content sources

- **The collection grid & lightbox** (`#/collection`) page through `GET /v1/collections/{slug}/items`
  (keyset-paged by number, `src/lib/memberIndex.ts`), showing what block.space certifies (id, number, content
  type/length, block height, attribution) at once and layering in what only `ord` knows (owner address,
  timestamp, fee) from a shared, prefetching cache (`src/lib/detailsCache.ts`) — neighbours are prefetched on
  lightbox open so prev/next never flashes "LOADING…" (a defect on the old site, fixed here).
- **The blog** (`#/blog`, "Degent Chronicles") is Markdown files in [`content/blog/`](content/blog), bundled at
  build time with `import.meta.glob('../../content/blog/*.md', { query: '?raw', eager: true })`
  (`src/lib/blog.ts`) — no CMS, no runtime fetch, a post ships with a normal PR and is reviewed like code. Front
  matter: `title`, `date` (`YYYY-MM-DD`), `slug` (keep the WordPress slug so `/blog/<slug>/` → `#/blog/<slug>`),
  optional `excerpt` / `cover` / `author` / `example: true`. One example post ships
  ([`content/blog/example-how-to-write-a-chronicle.md`](content/blog/example-how-to-write-a-chronicle.md)),
  marked with an "Example post" badge; delete it once a real post lands. `src/lib/markdown.tsx` renders a small,
  dependency-free Markdown subset (headings, paragraphs, bold/italic/code, links, lists, quotes, fenced code);
  raw HTML is shown as text, never executed.
- **Mint Process** (`#/mint-process`) builds its four rule cards straight from `DEGENT_RULES` in
  `@bsh/degent-mint-sdk` (`src/screens/MintProcess.tsx#ruleCards`) — the same rules the Studio and the mint
  service enforce — so the site can never drift from what the rules actually check.
- **The Comic, About, Manifesto** (`#/comic`, `#/about`, `#/manifesto`): the live site's copy for About and
  Manifesto, and the comic's inscription id, Ordiscan link and reader chapter list, were never captured from a
  screenshot. Per the site spec, the rebuild does not invent them — each renders a visible `TODO(copy)` block
  (`src/components/Sections.tsx#TodoCopy`) instead. Set `VITE_COMIC_INSCRIPTION_ID` to embed the comic's cover
  from the chain and enable "View in Ordiscan" once the id is known.
- **Artist pages** (`#/artists/:address`) join three independent sources, each optional and separately reported
  when missing: the studio's public profile (`GET /v1/artists/{address}`), the artist's certified members
  (`GET /v1/collections/{slug}/artists/{address}`, block.space's per-artist attribution) and their approved
  Studio artworks (`GET /v1/artworks?status=approved&artist=`).

### Global chrome (`src/components/SiteHeader.tsx`, `SiteChrome.tsx`)

A sticky header (wordmark, the two live meters once scrolled past `METERS_AFTER_PX`, **Mint** and **Buy** —
Magic Eden until first-party trading ships — and a hamburger) with a thin scroll-progress bar underneath; a
slide-out nav panel (focus-trapped, `Escape` closes, returns focus to the hamburger) listing Home · About · The
Collection · Gallery · Mint Process · Manifesto · Blog · Studio plus a light/dark theme switch
(`src/lib/theme.ts`, persisted); a floating left social rail (Telegram, X, Instagram — marked `TODO(copy)`
until its URL is captured) with a "back to top" chevron; and a footer with Quick Links and a newsletter form
that validates the address and says **"coming soon"** — it posts nowhere yet (`@bsh/notify` email subscriptions
are not wired up), and never claims a successful subscription.

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
3. **Hang a Degent** — `POST /v1/artworks` (title, description, type, length, optional edition cap
   `maxEditions` 1–10,000 via `src/screens/StudioExtras.tsx#CapField`; one-time upload token) →
   `PUT /v1/artworks/{id}/content` (exact bytes; the review runs once, there). Verdicts: **Hanging** (approved),
   **Rejected** with reasons and checks, or **Waiting for the house** (`reviewing` + `needsHuman`: a skipped check
   never approves; the page polls until the house decides).
4. **Your Degents** — every status with a pill; approved pieces can be **delisted**.
5. **Royalties** — `GET /v1/artists/me/royalties`: records with funding `txid:vout` explorer links, and totals.

### Editions, appeals and notifications ([ADR-0012](../../../../docs/adr/0012-edition-caps-curation-appeals.md))

`src/screens/StudioExtras.tsx` and `src/components/Editions.tsx` add the studio contract's newer surface,
read defensively everywhere (every field optional on the wire):

- **Edition caps** — `editionsOf()` reads `maxEditions` / `mintedEditions` / `soldOut` off any artwork.
  `EditionsEditor` (`PUT /v1/artworks/{id}/editions`) lets the artist raise, open (clear to no cap) or lower the
  cap on an approved piece from "Your Degents"; the studio refuses to lower it below what is already minted
  (409 `conflict`, the message names the minted count) — the editor surfaces that refusal rather than silently
  clamping. The gallery (`#/gallery?available=1|0`) and the artwork page show a **Sold out** badge and disable
  **Mint this Degent** once the cap is reached.
- **Appeals** — a rejected artwork can be appealed once at a time, at most 3 times over its life
  (`AppealForm`, `POST /v1/artworks/{id}/appeal`); `AppealBadge` shows the latest appeal's status (open /
  granted / denied) and the house's reasons when denied.
- **Notifications** — `NotifySettings` (`PUT /v1/artists/me` `notify`) registers a webhook URL and/or a
  Telegram chat for artwork and royalty events. The **webhook signing secret is shown exactly once**, the
  first time a webhook is set or on `rotateWebhookSecret`, with a copy button and an explicit "shown once,
  never stored" warning; the app never persists it. Clearing the webhook (`notify: null` for both, or
  `webhookUrl: null` for just the webhook) also deletes the secret.

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
| `VITE_CERTIFY_URL` | `https://certify.block.space` | block.space certification base URL (`/v1/collections/...` appended) — the **only** source for site counts |
| `VITE_COLLECTION_SLUG` | `degents` | The collection's slug at block.space |
| `VITE_COMIC_INSCRIPTION_ID` | unset | The comic's inscription id (64 hex + `i<n>`); unset shows a `TODO(copy)` placeholder instead of the cover/Ordiscan link |

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

The site's certificate and ord sources are also fakes (`src/services/fakeSite.ts`, `createFakeSite`): a
deterministic attestation shaped like the real one will be (4,112 members — 4,106 legacy manifest items + the
Open Studio mints — ~1.5 GB, one exclusion, an attribution summary for the two demo artists), signed with a
placeholder (non-BIP340) signature and clearly labelled **demo data**, never "certified", anywhere it is shown.

## Code map

| Path | What |
|---|---|
| `src/services/types.ts` | Ports: `MintApi`, `StudioApi`, `WalletService` (+ `signMessage`), `ChainApi`, `InscriptionOps`, `ImageTools`; optional studio fields of quotes/orders read defensively |
| `src/services/studioApi.ts` | Typed client for the studio contract (`createStudioApi`, `StudioApiError`, `editionsOf`, `latestAppeal`) |
| `src/services/certifyApi.ts` | Typed client for block.space certification (`createCertifyApi`, `CertifyApiError`, `verifiedRoyaltyOf`) |
| `src/services/ordApi.ts` | Typed client for ord's `/r/inscription/{id}` (address, timestamp, fee) — the lightbox's non-certified facts |
| `src/services/real/*` | Adapters: `@bsh/degent-mint-sdk` client, `@bsh/wallet-kit`, esplora/ord, `@bsh/inscription`, canvas |
| `src/services/fakes.ts` | Fakes for tests and `?demo=1` (scenarios: happy, rescue, reject; tamper switches; fake studio + generated gallery PNGs; ADR-0012 editions/appeals/notify) |
| `src/services/fakeSite.ts` | Fakes for the site's read-only sources: the demo certificate and demo ord details |
| `src/flow/` | State, reducer, key vault, effect sequences, React context; `studio.tsx` = the artist session; `site.tsx` = the shared certificate/member-index/details-cache/theme context |
| `src/lib/` | Pure helpers: hash router, compression search, funding PSBT/coin selection, rules, recovery, studio session, timeline, format, counts (attestation → certified/projected numbers), member index, ord details cache, pagination, blog (Markdown front matter), markdown renderer, scroll (progress bar / back-to-top), theme, site copy/links |
| `src/screens/` | `Home`, `Collection`, `MintProcess`, `SitePages` (Comic/About/Manifesto), `Blog`, `Artist`, plus the mint wizard steps, `Gallery`, `Artwork`, `Studio`, `StudioUpload`, `StudioRoyalties`, `StudioExtras` (editions/appeals/notify) |
| `src/components/` | `SiteHeader` + `SiteChrome` (global chrome: nav panel, social rail, footer, newsletter), `Sections` (hero/collection card/comic/banner), `Pagination`, `Lightbox`, `Meters` (the live gauges), `Editions` (sold-out badge), `Icons`, `Frame` (gold frame + plaque), `RulesPills`, `Link` |

Local rules delegate to `@bsh/degent-mint-sdk` (`validateContentMeta`, `sniffContentType`, `readImageInfo`)
with the service's own config; the app adds byte-level checks (magic bytes, length, SHA-256).

## Tests

`vitest` + `@testing-library/react` in jsdom, fakes only — nothing touches a network. 244 tests across 19 files
(163 before the site rebuild, p6.1).

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
- `test/router.test.ts` — every route (including the site pages and `?available`) parses and round-trips;
  `useRoute` follows `navigate()` and `hashchange`.
- `test/gallery.test.tsx` — Studio gallery renders from the fake (frames, DEGENT plaques, short artist addresses,
  featured first), paging, artist filter, the `?available` filter and the sold-out badge (ADR-0012); artwork page
  (image, artist link, five rule pills, edition count, SHA-256), "Mint this Degent" prefill and its refusal once
  an edition is sold out, shared `#/mint/:id` links, 404s.
- `test/artworkMint.test.tsx` — the wizard with an artwork: Create skips upload/compress, Quote's four lines with
  the artist address, Pay's outputs `[commit, artist royalty, club fee, change]`, bundle with `artworkId`/`edition`,
  Track's "Artist paid" `txid:1`, the studio ledger receiving the record.
- `test/studio.test.tsx` — sign-in round trip (challenge → `wallet.signMessage` → verify), session persistence and
  restore, sign-out, display name; payout proof with the taproot and the SegWit address, legacy refusal (UI and
  API: `payout_address_legacy`, `payout_proof_invalid`); upload flow: approved, rejected with reasons,
  `needsHuman` → "Waiting for the house" → resolved by polling, byte-rule failure blocks submit; artworks list with
  status pills and delist; royalties totals and explorer links; **ADR-0012**: an edition cap declared on upload,
  the editions editor raising/opening a cap and refusing to lower it below what is minted (409 `conflict`), an
  open edition, appeals (sent, shown as open, the house's decision reopens the form, the 3-per-artwork limit,
  409 `conflict` on a 4th), notification settings (webhook + Telegram, the one-time signing secret shown once and
  hidden, rotate, turn off, a non-`https` webhook refused).
- `test/site.test.tsx` — Home (hero, CTAs, the collection card from the certificate); projected-vs-certified
  labelling and demo-data labelling; the certificate unavailable shows no numbers, never a guess; The Collection
  (grid, the full pagination toolbar — per-page, page select, first/prev/…/next/last, "Go to" with range refusal,
  URL round-trip), the lightbox (details, next/prev/filmstrip/keyboard nav without extra history entries,
  neighbour prefetch so no "LOADING…" flash, an ord outage keeps the certified facts), a deep link past the end;
  Mint Process's four rule cards and "Did you know?"; Comic/About/Manifesto (`TODO(copy)`, the comic wired up once
  `VITE_COMIC_INSCRIPTION_ID` is set); the artist page joining its three sources (including one missing from
  each); global chrome (header meters, the nav panel and its focus trap, theme persistence, the social rail,
  the newsletter's "coming soon").
- `test/blog.test.tsx` — front-matter parsing (valid/invalid), the newest-first sort, the example post renders
  with its "Example post" badge, an unknown slug says so.
- `test/certify.test.ts` — `certifyApi`'s request shaping, error mapping (`bad_response`, `network_error`,
  contract error codes), `verifiedRoyaltyOf`'s shape checks.
- `src/lib/funding.test.ts` also covers the royalty target at [1], omission at 0, dust raise, `compareOutputs`;
  `test/payment.test.ts` the output-value tamper refusal and the studio-artwork money path;
  `src/lib/recovery.test.ts` the optional `artworkId`/`edition`.
- `test/demo.e2e.test.tsx` — the whole wizard flow through the UI in demo mode (jsdom).
- `e2e/demo.e2e.mjs` (`pnpm --filter @bsh/degent-web e2e`) — **real headless Chromium** via `playwright-core`
  (no bundled browsers: `CHROMIUM_PATH`, default `/opt/pw-browsers/chromium`, a binary or a directory to
  search). Builds, serves `vite preview` on a free port, and drives `?demo=1` through every page: Home →
  `#/collection` (grid + lightbox) → `#/mint-process` → `#/comic` → `#/about` → `#/manifesto` → `#/blog` (+ the
  example post) → `#/gallery` → an artwork → its `#/artists/:address` page → the Artist Studio (sign in, prove
  payout, set a notification webhook) → the mint wizard at `#/mint` through Connect, Create (real canvas
  encoder), Validate, Quote, Pay, Track and Delivered — at 1280 px and 400 px, failing on any console error,
  page error, horizontal page overflow or clipped progress nav. Google Fonts are stubbed for a hermetic run
  (system-font fallback in the renders). Screenshots: [`docs/screenshots/`](docs/screenshots)
  (`{1280,400}-01-home.png` … `-13-studio.png`, then the wizard `-14-welcome.png` … `-21-delivered.png`).

Defects found by the first real renders and fixed: the page backdrop used `background-attachment: fixed`
on `body`, which painted a viewport-high band with hard edges on long pages (now a fixed `body::before`
layer over a solid `html` background); the progress nav clipped step 7 at 400 px; the segmented "bytes to
inscribe" control broke its pill shape when it wrapped at 400 px; shortened addresses on Pay split at the
ellipsis at 400 px; the footer still said the reveal key never leaves the tab; at 400 px, with a wallet
connected, the header's `flex-wrap` never actually wrapped the wallet chip onto its own line (an auto-width
flex-wrap container has nothing to wrap against) and overflowed the viewport — fixed by giving
`.site-header__actions` a full-width flex-basis once it drops to its own row.

## Accessibility & design

Dark "private members' club" identity: lacquered bottle green, brass, ivory; Cormorant Garamond display,
Manrope UI, JetBrains Mono (tabular) for sats, bytes and hashes. Every control is labelled and keyboard
operable, focus moves to each step's heading, status changes are announced (`aria-live`), motion honours
`prefers-reduced-motion`, and the layout works down to 360–400 px.
