# @bsh/degent-web — degent.club

The whole **degent.club** site in one React + Vite app (replacing the WordPress site, mint.degent.club and
the marketplace front end; see [`../../docs/site-spec.md`](../../docs/site-spec.md)): home, the certified
collection gallery, the Atelier, the comic, the blog, the club, and the automated, non-custodial **mint at
`/mint`** (ADR-0002, amended by [ADR-0005](../../../../docs/adr/0005-strict-reveal-and-tiers.md)).

## Quickstart

```bash
pnpm --filter @bsh/degent-web dev        # http://localhost:5173  (add ?demo=1: no network, everything simulated)
pnpm --filter @bsh/degent-web test       # vitest + testing-library (jsdom)
pnpm --filter @bsh/degent-web typecheck
pnpm --filter @bsh/degent-web build      # → dist/  (static; needs an SPA fallback: unknown paths serve index.html)
pnpm --filter @bsh/degent-web e2e        # build + headless Chromium: every page + the mint, 1280 and 400 px, screenshots
```

## Site map

| Path | Page | Data |
|---|---|---|
| `/` | Home: hero wall, "The Decentralized Gentlemen Club", certified stat tiles, CTA Mint Now / Enter the Atelier, latest mints strip, comic teaser, Degen Minter banner | StatsService, membership list, mint `GET /v1/queue` |
| `/collection` | Hero over the wall, collection card (certified numbers + computed 10K projection), gallery with the full pagination toolbar (per page, page select, first/prev/1 2 3 4 … N/next/last, go to), comic teaser, minter banner | membership list (certified items → bundled fallback) |
| `/collection/:n` | Deep link: the lightbox (image, inscription id, address, content type/length, timestamp, block height, fee, View on Ordinals.com, Buy Item, prev/next, filmstrip, ←/→/Esc), per-item `<title>` / OpenGraph tags | OrdService (cached, neighbours prefetched) |
| `/mint` | The eight-step mint (below). Stays mounted once visited, so browsing away mid-order keeps its in-memory state | mint service, wallet, esplora, ord |
| `/atelier` | Generate with AI (brief, style chips, placard, tier with indicative cost, 1-4 variations → job polling → candidates in gold frames → finalize) or Bring your own art (picker + drag and drop, "use as-is" or "frame it for me"). Minting Rules checklist always visible and per candidate. "Mint this" → `/mint` | AtelierService (`contracts/openapi/degent-atelier.yaml`) |
| `/comic` | "This is Gentlemen- The Comic" + reader: the on-chain comic from ord `/content/<id>` in a sandboxed iframe (`allow-scripts` only), View in Ordiscan | `VITE_COMIC_INSCRIPTION_ID` |
| `/manifesto`, `/about` | `TODO(copy)` placeholders (the live copy was not captured and is never invented) | `VITE_COPY_READY` |
| `/how-it-works` (`/mint-process`) | Minting Rules (the four rule cards verbatim), "Did you know?", tiers × lanes table with indicative cost, wallets, "what happens after you pay" | mint `GET /v1/fees`, wallet list |
| `/blog`, `/blog/:slug` | "Degent Chronicles": two-column post cards, post pages | `src/content/blog/*.md` (build time) |
| `/club` | Sign in with Bitcoin (BIP-322; ECDSA on Horizon) → your Degents (ord holdings ∩ membership), perks placeholder | wallet-kit `signMessage`, OrdService |

Global chrome on every page: sticky header (logo + `degent.club` wordmark, the two live meters, Mint and Buy
buttons, hamburger → right slide-out menu with icons and a gradient Mint Now!), scroll-progress bar, left social
rail (desktop ≥ 1360 px; in the footer on smaller screens), back-to-top, footer with Quick Links and the
newsletter form. On screens below 1100 px the meters move to a compact strip under the header.

### One source of truth for the numbers

The meters (`minted N / 10K`, `inscribed MB / 3 GB`), the collection card and the home tiles all read
**one** `StatsService` whose only source is the block.space certification attestation
(`GET {VITE_CERTIFY_URL}/v1/collections/degents`); hovering or focusing a meter shows "Certified by
block.space at block H". If certification is unavailable the UI says so and shows **no number** (never the
live site's hardcoded 4,027 / 1,470 MB). The "3 GB" meter is labelled a goal; the card shows
`projected ~X GB at 10K`, computed from the certified average, never "10K = 3+ GB" as fact. In demo mode the
bundled manifest summary (4,112 Degents, ≈ 1,508 MB) stands in, labelled "not certified (demo)".

Certification API shapes accepted (`src/site/services/real/certify.ts`; the contract lives in
DegentClub/blockspace and is not vendored here, so the parser is tolerant and refuses to guess):
`{ supply?, attestation: { height|block_height, issued_at, stats: { count|item_count, total_bytes|content_bytes } } }`
(camelCase too, or stats at the top level) and items pages `{ items: [{ inscription_id|id, number, content_length? }], next_cursor }`.
The membership list follows cursors; if the API is not configured or fails, the bundled snapshot
`src/data/collection.json` (4,112 entries: id, number, name, size_kb, from the legacy
Degent-Marketplace `collection.json`, public on-chain data) is used and labelled as such. It is a
separate lazy chunk (~530 KB).

### Atelier → mint handoff

"Mint this" fetches `GET /v1/content/{sha256}` from the Atelier, recomputes the SHA-256 with
`@bsh/degent-mint-sdk` and **refuses** bytes whose hash differs, then hands that exact `Uint8Array` to the mint
through a new reducer entry point, `HANDOFF` (`src/flow/reducer.ts`): Create is skipped; the flow lands on
**Validate** (or on Connect first when no wallet is connected; its button then says "Continue to Validate").
`HANDOFF` is refused once money may have moved. Upload "use as-is" hands the file's bytes unchanged
(after the rules checklist and your confirmation of the design/frame rules); "frame it for me" uses the
Atelier's `POST /v1/upload`. Tests assert that the bytes the mint `PUT`s are byte-identical to the Atelier's
content and have the same SHA-256 (`test/site/atelier.test.tsx`).

States rendered honestly: provider not configured (`/v1/health` `provider.mode: fake`), Atelier not configured
or unreachable (upload as-is still works), quota used / exceeded, rate limited (with `Retry-After`), daily cost
cap, failed jobs, `range_unreachable`, `review_rejected`, hash mismatch.

### Club sign-in

The Club formats a Blockspace ID "Sign in with Bitcoin" challenge (`src/site/lib/siwb.ts`, the format
`@bsh/identity` parses) and asks the wallet to sign it: BIP-322 with the ordinals address where supported,
ECDSA/BIP-137 with the SegWit payment address on Horizon (which cannot sign BIP-322). **Verification is the
identity service's job** (`POST /siwb/verify`, nonce store): `@bsh/identity` is not among this app's allowed
imports (products/degent/CLAUDE.md rule 5) and a browser cannot hold a trustworthy nonce store. Until that
service is connected the page is a read-only view of public chain data for the connected address and grants
nothing; it says so.

### Blog

Posts are markdown files in `src/content/blog/*.md` with front matter (`title`, `date` YYYY-MM-DD, `cover`
URL or `placeholder:<kind>`, `excerpt`, optional `slug`, `draft`, `tags`), parsed at build time by a tiny parser
(`src/site/lib/frontmatter.ts`) and rendered by a small markdown renderer that produces React elements, never
raw HTML (`src/site/lib/markdown.tsx`). The two posts in the repo are **PLACEHOLDER drafts** (`draft: true`),
shown only in demo mode. To import the real WordPress posts (URL slugs are kept):

```bash
curl -s 'https://degent.club/wp-json/wp/v2/posts?per_page=100&_embed=1' > wp-posts.json   # once, by hand
node scripts/import-wordpress.mjs wp-posts.json            # → src/content/blog/<slug>.md (no network)
```

Then review the files and delete the placeholders.

### Deep links and OpenGraph

`/collection/:n` sets the document title, description and `og:*` tags on navigation. Scrapers that do not
run JavaScript see only `index.html`'s defaults; per-item previews for them need a prerender or an edge
rewrite of `index.html` (not included).

## The mint (`/mint`)

**What you see is what lands on chain:** the preview is rendered from the exact bytes that go into the
envelope, the SHA-256 is shown before upload and re-checked against ord after confirmation, and the
commit address is recomputed in the browser with `@bsh/inscription` before anything is payable.

### Flow

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
| `VITE_CERTIFY_URL` | unset | block.space certification API base. Unset: stats show "unavailable" (demo: bundled manifest) and membership uses the bundled snapshot |
| `VITE_ORD_URL` | `https://ordinals.com` | ord server: `/content/<id>` images, `/inscription/<id>` and `/address/<addr>` JSON |
| `VITE_MINT_API_URL` | `/api` | Mint service base URL (`/v1/...` is appended) |
| `VITE_ATELIER_URL` | unset | Atelier service base URL. Unset: generation says "not configured"; upload as-is still works |
| `VITE_NEWSLETTER_URL` | unset | Newsletter endpoint: `POST` JSON `{ name, email, channel: "email", source }` (a `@bsh/notify` email subscription; 409 = already subscribed). Unset: the form is disabled with a note (no mailto) |
| `VITE_COMIC_INSCRIPTION_ID` | unset | Inscription id of the on-chain comic. Unset: placeholder cover |
| `VITE_COPY_READY` | unset | Comma list of `manifesto,about` whose final copy has shipped. Others are hidden from navigation in production |
| `VITE_MARKETPLACE_URL` | Magic Eden `ordinals/marketplace/degentclub` | The Buy button |
| `VITE_X_URL`, `VITE_TELEGRAM_URL`, `VITE_INSTAGRAM_URL` | x.com/degentclub, the Telegram invite, unset | Social links. Instagram is shown only when set (no verified handle in the spec) |
| `VITE_NETWORK` | `mainnet` | `mainnet` \| `testnet` (testnet4) \| `signet` \| `regtest` |
| `VITE_ESPLORA_URL` | mempool.space per network | Esplora-compatible API for UTXOs and broadcast |
| `VITE_EXPLORER_URL` | `https://explore.block.space` | Block explorer for tx links (`/tx/<txid>`) |
| `VITE_POLL_MS` | `5000` (`1200` in demo) | Order polling interval (the Atelier polls at most every 2 s) |

## Demo mode

Open any page with **`?demo=1`** (the parameter survives navigation). A striped **DEMO** ribbon is always
visible. Nothing touches the network (the e2e aborts and fails on any external request): stats and membership
come from the bundled manifest; ord details are deterministic fixtures; images are generated placeholder
gentlemen (labelled DEMO); the Atelier is a fake whose compositor runs in your browser (canvas: frame,
placard, JPEG, padded to the tier with JPEG comment segments); the newsletter is a fake
(`…fail…@` fails, `member@…` is already subscribed); wallet, mint service, chain and inscription maths are the
mint's fakes (`src/services/fakes.ts`; the fake wallet holds real keys and really signs, so the txid safety
check runs for real). TODO(copy) pages and draft blog posts are visible only in demo. No bitcoin moves.

## Code map

| Path | What |
|---|---|
| `src/site/Site.tsx` | Router + chrome + pages; embeds the mint at `/mint` and owns the handoff |
| `src/site/router.tsx` | History-API router (`parseRoute`, `Link`, `memoryHistory` for tests) |
| `src/site/services/types.ts` | Site ports: `StatsService`, `CollectionService`, `OrdService`, `NewsletterService`, `AtelierService` |
| `src/site/services/real/*` | certification API, ord JSON, newsletter POST, Atelier HTTP client (contract) |
| `src/site/services/fakes.ts`, `demoPainter.ts` | Site fakes and the demo canvas compositor |
| `src/site/chrome/`, `components/`, `pages/` | Header, meters, menu, footer, newsletter; frames, pagination, lightbox; one file per page |
| `src/site/lib/` | Pure helpers: pagination, stats/projection, front matter, markdown, rules checklist, handoff, JPEG padding, SIWB text, meta |
| `src/content/blog/`, `src/data/collection.json` | Blog posts; bundled membership snapshot |
| `scripts/import-wordpress.mjs` | WordPress export → markdown posts (local file only) |
| `src/App.tsx` | The mint wizard (standalone or `embedded`; `handoff` prop) |
| `src/services/types.ts` | Mint ports: `MintApi`, `WalletService` (now with `signMessage` + capabilities; 7 wallets incl. XCP, Horizon), `ChainApi`, `InscriptionOps`, `ImageTools` |
| `src/services/real/*` | Adapters: `@bsh/degent-mint-sdk` client, `@bsh/wallet-kit`, esplora/ord, `@bsh/inscription`, canvas |
| `src/services/fakes.ts` | Mint fakes for tests and `?demo=1` (scenarios: happy, rescue, reject; tamper switches) |
| `src/flow/` | State, reducer (incl. `HANDOFF`), key vault, effect sequences, React context |
| `src/lib/` | Pure helpers: compression search, funding PSBT/coin selection, rules, recovery, timeline, format |
| `src/screens/` | One component per mint step |

Local rules delegate to `@bsh/degent-mint-sdk` (`validateContentMeta`, `sniffContentType`, `readImageInfo`,
`sha256Hex`, `tierForSize`) with the service's own config; the app adds byte-level checks (magic bytes, length,
SHA-256). The only fee arithmetic the site does itself is the clearly labelled *indicative* "≈ bytes ÷ 4 vB ×
rate" in the tier tables (`src/site/lib/cost.ts`); the binding number is always the mint's quote.

## Tests

`vitest` + `@testing-library/react` in jsdom, fakes only — nothing touches a network.

Site (`test/site/`):

- `router.test.tsx` — path parsing/round-trips, `?demo=1` carried, Link navigation, menu navigation, Esc + focus return.
- `pages.test.tsx` — every page renders in demo with the chrome; per-page title; Minting Rules verbatim, tiers, wallets;
  TODO(copy) visible in demo, hidden from nav in production until `VITE_COPY_READY`; comic iframe sandbox; home strip.
- `stats.test.tsx` — meters, strip and card bind to StatsService (certified numbers, "certified at block H" tooltip,
  computed projection) and never render the live site's hardcoded numbers; "unavailable" on failure; certification
  parsing, cursor following, fallbacks; bundled summary = 4,112.
- `pagination.test.ts` — paging maths incl. property checks over page windows and item coverage.
- `lightbox.test.tsx` — toolbar paging; LOADING → facts; neighbour prefetch; next/prev/keyboard/filmstrip; deep link
  lands on the right grid page; ord error + retry; unknown number.
- `atelier.test.tsx` — job lifecycle (queued → running → done) with a fake, per-candidate rules, finalize, **handoff to
  the mint with byte-identical bytes and the same SHA-256** (captured at the mint's `PUT /content`); hash-mismatch
  refusal; quota / rate-limit / cost-cap / failed-job / not-configured states; upload as-is (bytes unchanged),
  non-square refusal, frame-it path, drag and drop.
- `handoff.test.ts` — `HANDOFF` reducer entry (Welcome→Connect after config, straight to Validate with a wallet,
  refused after payment) and exact-size JPEG padding.
- `blog.test.tsx`, `wordpress.test.ts` — front-matter parser, drafts only in demo, safe markdown, WordPress import.
- `newsletter.test.tsx` — form validation, success / already / error / not configured; HTTP client status mapping.
- `club.test.tsx` — BIP-322 sign-in with the ordinals address and the SIWB text, owned Degents = holdings ∩
  membership, Horizon ECDSA with the payment address, rejection, empty state.
- `clients.test.ts` — Atelier HTTP client against the contract (session bearer, error codes + Retry-After, upload
  query, content by hash) and the ord JSON client (parsing, caching).

Mint:

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
  search). Builds and serves `vite preview` on a free port. **Site pass**: renders every page at 1280 and 400 px
  (`docs/screenshots/site-<width>-<page>.png`), the open menu, the lightbox deep link (must fit the viewport;
  next, Esc), the Atelier generate → finalize → Mint this → Validate (same SHA-256) → Approved, and the Club
  sign-in; fails on console errors, page errors, horizontal overflow and **any external network request**.
  **Mint pass**: drives `/mint?demo=1` through all eight screens (welcome,
  connect, create with the real canvas encoder, validate, quote, pay, track, delivered) at 1280 px and 400 px,
  and fails on any console error, page error, horizontal page overflow or clipped progress nav. Google Fonts
  are stubbed for a hermetic run (system-font fallback in the renders). Screenshots:
  [`docs/screenshots/`](docs/screenshots) (`1280-01-welcome.png` … `400-08-delivered.png`).

Defects found by the site renders and fixed: the lightbox panel sized itself to its content inside a grid
container and overflowed a 400 px viewport (now a block scroller; the e2e measures it); the demo compositor's
SVG source had no intrinsic size, so the canvas crop painted an empty frame; the latest-mints strip wrapped 7 + 1
at 1280 px; the placeholder "DEMO" label collided with the DEGEN plaque; the Atelier tab label clipped at 400 px;
the embedded mint showed an empty sub-bar before a wallet was connected.

Defects found by the first real renders of the mint and fixed: the page backdrop used `background-attachment: fixed`
on `body`, which painted a viewport-high band with hard edges on long pages (now a fixed `body::before`
layer over a solid `html` background); the progress nav clipped step 7 at 400 px; the segmented "bytes to
inscribe" control broke its pill shape when it wrapped at 400 px; shortened addresses on Pay split at the
ellipsis at 400 px; the footer still said the reveal key never leaves the tab.

## Accessibility & design

The live identity (docs/site-spec.md), polished: ground `#0b0b0d`, cards `#1a1a1d` / `#1b1b23`, borders
`#2a2a2d`, degent green `#2efc86`, green → yellow gradient CTAs, gold frames with a DEGEN plaque, hard offset
shadows, pill badges, green section rules; Space Grotesk (Google Fonts, system fallbacks) and JetBrains Mono for
ids and numbers. Dark only, by design. The mint screens use the same tokens. Every control is labelled and
keyboard operable with a visible green focus ring; the menu and lightbox are modal dialogs (Esc, focus kept
inside and returned); focus moves to each page's heading on navigation and to each mint step's heading; status
changes are announced (`aria-live`); motion honours `prefers-reduced-motion`; layouts are checked at 400 px with
no horizontal page scroll.
