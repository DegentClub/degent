# @bsh/degent-web — degent.club

The degent.club website and its automated, non-custodial mint for the Decentralized Gentlemen Club (ADR-0002):
one app for what used to be three properties (WordPress site, mint, marketplace). Pages, copy and visual identity
follow [`products/degent/docs/site-spec.md`](../../docs/site-spec.md); its "Implementation status" section maps
every spec item to done / todo.
**What you see is what lands on chain:** the preview is rendered from the exact bytes that go into the
envelope, the SHA-256 is shown before upload and re-checked against ord after confirmation, and the
commit address is recomputed in the browser with `@bsh/inscription` before anything is payable.

```bash
pnpm --filter @bsh/degent-web dev        # http://localhost:5173  (add ?demo=1 for the full simulated flow)
pnpm --filter @bsh/degent-web test       # vitest + testing-library (jsdom)
pnpm --filter @bsh/degent-web typecheck
pnpm --filter @bsh/degent-web build      # → dist/
```

## Routes

| Path | Page | Data | Who | Tests |
|---|---|---|---|---|
| `/` | Home: hero over the wall of framed Degents, certified stats next to the projection, the two live meters, the comic teaser, latest mints, the Degen Minter call to action | `/v1/stats`, `/v1/explorer` | anyone | `test/site.test.tsx` |
| `/collection` | The Collection: hero, collection card, filters (number, tier, size), sort, "Showing 1–20 of N", per page, page select, first/prev/numbers/next/last, go to; lightbox with inscription id, owner, content type/length, timestamp, block height, fee (ord `/r/inscription`, prefetched per page, cached), "View on Ordinals.com", "Buy Item" (marketplace link until first-party trading ships) | `/v1/explorer` (+ `tier`, `minBytes`, `maxBytes`), ord | anyone | `test/site.test.tsx` |
| `/collection/:n` | One Degent, shareable: title, description, OpenGraph/Twitter tags and a schema.org `VisualArtwork` JSON-LD block (client-side; see "Share cards") | `/v1/register/{n}`, ord | anyone | `test/site.test.tsx` |
| `/mint` | The mint wizard (below): Design → Mint → Confirm → Approve; Create holds **the Atelier**; Track shows the four stages, the live member tally, the declined state with the parent-less reveal, "Notify me", and a share card once delivered | mint API | anyone | `test/demo.e2e.test.tsx`, `test/atelier.test.tsx` |
| `/track/:id` | Track one order by id (notification links point here). On the device that paid, the recovery bundle is picked up automatically | `/v1/orders/{id}` | the minter | `test/notify.test.tsx` |
| `/comic` | The comic, embedded from its inscription (ord `/content`, sandboxed iframe) with zoom, full screen and "View on ordinals.com"; page by page with `VITE_COMIC_PAGES`; placeholder until configured | ord | anyone | `test/site.test.tsx` |
| `/how-it-works` | Minting Process: the four Minting Rules, tiers and live fees (worked examples from `@bsh/inscription`), wallets, Design → Mint → Confirm → Approve, member review, self-rescue with the passphrase, the recovery bundle | `/v1/config`, `/v1/fees` | anyone | `test/site.test.tsx` |
| `/club` | Holders' area: sign in with Bitcoin (SIWB), your Degents, links to `/review` and the Telegram gate; perks `TODO(copy)` | `/v1/auth/*`, `/v1/register/holder/{address}` | holders | `test/site.test.tsx` |
| `/manifesto`, `/about` | `TODO(copy)` placeholders: the live copy was not captured and must not be invented | – | anyone | `test/site.test.tsx` |
| `/review` | The members' vote (ADR-0007): SIWB sign-in, orders in `member_review`, Approve / Decline by signing `Approve Degent order <id> (<ref>)` | `/v1/review`, votes | holders | `test/members.test.tsx` |
| `/explorer` | The Register: stats header, filter/sort/paginated grid, member detail | `/v1/stats`, `/v1/explorer` | anyone | `test/members.test.tsx` |
| `/verify?tg=<token>` | Telegram gate landing: connect, sign the gate statement, POST to `VITE_GATE_URL` | gate service | holders | `test/members.test.tsx` |
| anything else | Not found, with a way home | – | – | `test/site.test.tsx` |

Routing is a few lines in `src/router.ts` (`matchRoute`: pathname → route + `:n` / `:id`); `?demo=1` works on every
page and seeds three strangers' orders into the review queue. The static host must serve `index.html` for every
path above (SPA fallback).

**Global chrome** (`src/site/chrome.tsx`): sticky header with the logo, the two meters ("4,112 / 10K · 41.12%
MINTED", "1,508MB / 3GB · 50.27% INSCRIBED", the 3 GB labelled a projection), Mint and Buy, a hamburger opening the
slide-out menu (modal dialog, Escape closes, focus trapped and returned), a scroll-progress bar, the social rail
with "back to top", and the footer (tagline, quick links, socials, newsletter). **One source of numbers:** header,
Home and Collection read the same `/v1/stats` object (`src/site/data.tsx`), fetched once; demo mode serves it from
the fakes. The newsletter form is disabled: the mint API has no newsletter endpoint yet (roadmap p3.30); per-order
notifications are on Track.

## The Atelier (Create step)

Upload a picture or start from a template (procedural backdrops; the gentleman is still yours to paint), crop it
square (zoom and position), set the gold frame (5–25 % of the edge) and the placard (`DEGEN`, `DEGENT` or `REGEN`),
choose the output size, and the browser composes it on a canvas (`src/atelier/composition.ts` geometry,
`draw.ts` painting). A target-size slider inside the chosen tier's byte range (from `@bsh/degent-mint-sdk`) drives a
binary search on the JPEG quality using the bytes `canvas.toBlob` really returns (`sizeSearch.ts`, ported from the
hardened combiner). The readout shows the file size, the exact reveal vbytes/weight and the fee at the current rate
from `@bsh/inscription` (`src/lib/revealEstimate.ts`: `estimateRevealWeight` + `quoteReveal`, no maths of its own),
and the four Minting Rules with their state (`mintingRules.ts`: measured, confirmed by you, or always). "Use this
design" hands the exact bytes to the wizard. "A finished file" keeps the older compression toolkit.
Not in this pass: server-side AI frame generation (the legacy combiner's authenticated, rate-limited
`/api/generate-frame` route is the reference; roadmap p1.30).

## Share cards (OpenGraph for `/collection/:n`)

`useDocumentMeta` sets title, description, `og:*`, `twitter:*` and JSON-LD on navigation, which serves crawlers that
run JavaScript. **Link unfurlers (X, Telegram, Discord) do not run JavaScript**, so a shared `/collection/4113`
shows the site's default card until an edge function (or a build-time prerender of the Register) answers
`/collection/:n` with the same tags server-side and an `og:image` rendered from the inscription (a PNG of the
framed Degent: most unfurlers refuse SVG/WebP and `ord /content` bodies over a few MB). `degentMeta()` in
`src/pages/DegentPage.tsx` is the single definition of those tags for that edge function to mirror. Roadmap p2.12.

## Notifications ("Notify me")

Track offers email or Telegram news for the order (`POST /v1/orders/{id}/subscriptions`, order token): member
review started, declined, self-rescue open, delivered ("Degent #N joined the club, block X"). Welcome can take the
choice before the order exists; it is kept in memory only and subscribed on Track. Delivery is the mint service's
(`@bsh/notify`).

## Flow

```
 Welcome ─► Connect ─► Create ─► Validate ─► Quote ─► Pay ───────────────────────► Track
 tiers,     wallet-kit  exact     mint-sdk    fee rate  1 Prepare                     poll GET /v1/orders/{id}
 live fees  ordinals vs bytes,    rules       breakdown   UTXOs (esplora)             ADR state timeline + tx links
 & queue    payment;    compress  locally,    lane/queue  funding PSBT + txid         verified → ord /content
            legacy      to tier   then PUT    ETA,        half-signed reveal (K_e,    side-by-side + "hash match ✓"
            refused     range,    content →   expiry,       0x81)                     rescue_available | declined →
                        SHA-256,  art review  commit addr POST /reveal                  passphrase → decrypt K_e →
                        preview   (approved?) VERIFIED?   K_e encrypted (passphrase)    re-sign [commit]→[child]
                                                          save recovery (localStorage)  (bytes from the mint, or the
                                                          wipe plaintext K_e            re-selected file)
                                                        2 Sign (wallet) → txid check
   ▲                                                      → broadcast
   └── on load: recovery bundle found in localStorage → "Resume tracking"
```

The wizard is a pure reducer (`src/flow/reducer.ts`) with an entry guard per step (`canEnter`): no Quote
without an approved review, no Pay without a verified commit address and a live quote, no going back once
money may have moved. Side effects live in `src/flow/effects.ts` and are written against ports so their
**order** is tested.

### The money path (ADR-0002 §2, ADR-0005), in order

1. `openOrder` — generate the ephemeral key `K_e` (in-memory `KeyVault`, never in React state), `POST /v1/orders`
   with only its x-only pubkey, keep the returned `orderToken` in memory, `PUT` the exact bytes (bearer token),
   wait for the art review.
2. `verifyCommit` — `@bsh/inscription.commitAddress(K_e.pub, bytes, parent, network)` must equal the service's
   **binding** quote. Mismatch or indicative quote → Pay is disabled.
3. `preparePayment` — require a recovery passphrase (≥ 8 characters, typed twice), fetch payment UTXOs
   (esplora), build the funding PSBT (commit output at vout 0, service fee if > 0, change) and compute its txid
   from the unsigned tx (nested-SegWit scriptSigs included), `buildHalfSignedReveal` with
   `SIGHASH_ALL|ANYONECANPAY` (0x81) over `[parent return, child]` — output 0 is the quote's
   `parentReturnAddress` with exactly `parentValueSats` — encrypt `K_e` with the passphrase, `POST /reveal`,
   **save the recovery bundle**, **wipe the plaintext `K_e`**.
4. The bundle is shown as copyable JSON (no download links) with a privacy warning; the user confirms they
   kept a copy.
5. `signAndBroadcast` — the wallet signs **without** broadcasting; we finalize, check the txid equals the one
   the reveal was signed against (a wallet that edits the tx would otherwise strand the funds), then broadcast
   via the wallet's `pushTx` or esplora `POST /tx`.

The wallet is never asked to sign before steps 3's reveal upload and recovery save have completed.

### Recovery bundle

`localStorage["degent.club/recovery/v2"]` (`src/lib/recovery.ts`): order id, network, API URL, funding
txid/vout, commit value, recipient, postage, quoted fee rate, content type and hash, parent id, reveal public
key, **`K_e` encrypted** (`src/lib/keyCrypto.ts`: AES-256-GCM, key from PBKDF2-SHA256 with 600,000
iterations over the recovery passphrase, order id + reveal pubkey as additional data; WebCrypto) and the
**order token**. The passphrase is never stored or sent. It is the only place the token and the key are
persisted; neither appears in URLs or logs. The bundle alone cannot move anything; bundle **and** passphrase
can spend the commit, so the UI says to keep them apart. Version-1 bundles (0x83 era) are not recognised.

Rescue (`rescue_available` and `declined`, ADR-0005): the user types the passphrase; `rescue()` fetches
`GET /rescue` with the token and uses only the artwork bytes from it (every other field must equal the
bundle, and the bytes must match the bundle's SHA-256), decrypts `K_e`, re-signs `[commit] → [child]` with
`@bsh/inscription.buildResignedRescue` (SIGHASH_DEFAULT, at least the quoted fee rate), wipes the key, and
broadcasts via wallet `pushTx` or esplora. If the service is unreachable, the bytes come from the artwork
still in memory or from the file the user re-selects. Without the bundle or the passphrase there is no
self-rescue (the mint's normal path does not need either).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_MINT_API_URL` | `/api` | Mint service base URL (`/v1/...` is appended) |
| `VITE_NETWORK` | `mainnet` | `mainnet` \| `testnet` (testnet4) \| `signet` \| `regtest` |
| `VITE_ESPLORA_URL` | mempool.space per network | Esplora-compatible API for UTXOs and broadcast |
| `VITE_EXPLORER_URL` | `https://explore.block.space` | Block explorer for tx links (`/tx/<txid>`) |
| `VITE_ORD_URL` | `https://ordinals.com` | ord server for `/content/<inscription id>` |
| `VITE_POLL_MS` | `5000` (`1200` in demo) | Order polling interval |
| `VITE_GATE_URL` | empty | Telegram gate endpoint for `/verify` (empty disables it) |
| `VITE_SITE_URL` | `https://degent.club` | Public origin for share links, OpenGraph URLs and JSON-LD |
| `VITE_BUY_URL` | Magic Eden collection page | Header "Buy" |
| `VITE_BUY_ITEM_URL` | `https://magiceden.io/ordinals/item-details/{id}` | Lightbox "Buy Item" (`{id}` = inscription id) |
| `VITE_COMIC_INSCRIPTION_ID` | empty | The comic's inscription id (`/comic` shows a placeholder when empty) |
| `VITE_COMIC_PAGES` | empty | Optional comma-separated page inscription ids for the page-by-page reader |
| `VITE_X_URL`, `VITE_TELEGRAM_URL`, `VITE_INSTAGRAM_URL` | x.com/degentclub, the club's t.me invite, empty | Socials (empty hides the link) |

Only well-formed inscription ids (`<txid>i<n>`) are accepted for the comic settings.

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
| `src/screens/` | One component per step, plus `/review`, `/explorer`, `/verify` |
| `src/pages/` | Site pages: Home, Collection, DegentPage, Comic, HowItWorks, Club, TodoCopy (Manifesto, About, NotFound) |
| `src/site/` | Chrome (header, menu, rail, footer), shared site data (stats + ord info cache), lightbox, details, meta |
| `src/atelier/` | Atelier geometry, canvas drawing, size search, Minting Rules |
| `src/components/Atelier.tsx`, `Notify.tsx` | The Atelier UI; "Notify me" on Welcome and Track |

Local rules delegate to `@bsh/degent-mint-sdk` (`validateContentMeta`, `sniffContentType`, `readImageInfo`)
with the service's own config; the app adds byte-level checks (magic bytes, length, SHA-256).

## Tests

`vitest` + `@testing-library/react` in jsdom, fakes only — nothing touches a network.

- `src/flow/reducer.test.ts` — every transition and guard.
- `src/lib/compression.test.ts` — byte-range search with a mocked canvas encoder (fit, too-small, downscale, too-large).
- `src/lib/funding.test.ts` — coin selection, dust, inscription guard, legacy refusal; precomputed txid equals the
  signed tx id for P2WPKH, P2SH-P2WPKH and P2TR payment addresses.
- `test/payment.test.ts` — **call order**: reveal POSTed and recovery saved and `K_e` wiped before
  `wallet.signPsbt`; no wallet call when the reveal upload fails; altered funding tx is never broadcast;
  order-token handling incl. missing-token errors; commit verification; the 0x81 reveal carries the quoted parent
  return and `K_e` is only in the bundle encrypted; rescue re-signed with `K_e` (service bytes, local bytes,
  wrong passphrase, a service whose parameters disagree with the bundle, no bundle).
- `src/lib/keyCrypto.test.ts`, `src/lib/recovery.test.ts` — K_e encryption (round trip, wrong passphrase, binding to
  the order, tampering) and the v2 bundle format.
- `test/inscription.test.ts` — the real `@bsh/inscription` adapter: 0x81 reveal accepted by `verifyHalfSignedReveal`
  only with the right parent return; re-signed rescue shape.
- `test/rules.test.tsx`, `test/quote.test.tsx` — rules display, review results, quote rendering (sats + BTC),
  commit-address mismatch blocking, Block Degent warnings, fee clamping and re-quote.
- `test/track.test.tsx` — timeline for every ADR status, delivered + hash match, rescue with the recovery passphrase
  (service up, service down, wrong passphrase, re-selected artwork after a reload), resume from localStorage.
- `test/atelier.test.tsx` — composition geometry (square crop, frame 5–25 %, placard placement), placard values,
  size search on a mocked `canvas.toBlob` (converges inside the tier bounds; too small / too large / no fit), the
  Minting Rules states, the reveal estimate against a real signed transaction, and the Atelier in the Create step.
- `test/site.test.tsx` — every page has one h1, the landmarks and alt text; header meters and the one stats source;
  menu focus trap; Home; Collection pagination, filters, lightbox (prefetched details, links, keyboard); deep-link
  meta and JSON-LD; comic embed and reader; How it works; Club sign-in; TODO(copy) pages; not found.
- `test/notify.test.tsx` — "Notify me" on Track and Welcome, `/track/:id` without a token, the real adapters.
- `test/demo.e2e.test.tsx` — the whole flow through the UI in demo mode: Home → mint (Atelier) → delivered → the
  new Degent in the Collection's lightbox.

## Accessibility & design

The site spec's identity (`src/site.css`, which also re-points the mint screens' tokens): ground `#0b0b0d`, cards
`#1a1a1d`/`#1b1b23`, borders `#2a2a2d`, degent green `#2efc86`, the green → yellow CTA gradient, Bitcoin orange for
call-outs, gold frames with a `DEGEN` plaque, hard offset shadows, pill badges and green rules; Space Grotesk for
display and UI, JetBrains Mono (tabular) for sats, bytes and hashes. Every page has exactly one `h1` (focused on
navigation), `header`/`main`/`footer` landmarks, alt text on every image (empty for decorative walls), labelled and
keyboard-operable controls (menu and lightbox are modal dialogs with trapped focus, Escape, and ←/→ in the
lightbox), announced status changes (`aria-live`), `role="meter"` progress bars, motion honouring
`prefers-reduced-motion`, and layouts down to 360 px.
