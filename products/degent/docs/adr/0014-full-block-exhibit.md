# ADR-0014: The Full Block Exhibit — a Full Block Degent as a museum object

- **Status:** Accepted
- **Date:** 2026-09-25
- **Deciders:** team-degent (product), with block.space (X-Ray / Block Theater, ADR-0008)
- **Components:** `@bsh/degent-web` (new `/exhibit` route), reuses `@bsh/inscription` and `@bsh/degent-mint-sdk`
- **Related:** [ADR-0005](0005-strict-reveal-and-tiers.md) (tiers by content bytes, lanes by weight, the block-lane
  weight budget), [ADR-0002](0002-degent-mint-architecture.md) (parent-linked provenance),
  block.space [ADR-0008](../../../../blockspace/docs/adr/0008-transaction-xray-and-block-theater.md) (Transaction
  X-Ray and Block Theater — the weight-proportional visualisation this borrows), `products/degent/docs/site-spec.md`
  (one source of truth for numbers; `TODO(copy)` for uncaptured copy).

## Context

degent.club is the **Own** rung of Blockspace Holdings' learning ladder (See → Understand → Write → Own). The
emotional peak of that rung is the one artwork that fills nearly a whole Bitcoin block: a **Full Block Degent**
(`fullblock` tier, content ≥ 3.5 MB — ADR-0005 §3). Nothing on the rebuilt site yet turns that object into a
lesson. The collection gallery (`/collection`) treats every Degent the same; the physical limit of the chain —
4,000,000 weight units per block, the witness discount that lets ~3.96 MB of image ride in one block, one such
inscription per block by construction — is never shown.

We want a room in the site that presents a Full Block Degent as a museum object and uses it to teach that limit,
honestly (no invented lore, no invented numbers, illustrative figures labelled), machine-readable, and usable on a
gallery screen.

## Decision

### 1. A new route, `/exhibit` and `/exhibit/{n}`

- `/exhibit` lists the collection's Full Block Degents. Membership is the same source as the rest of the site:
  the block.space certification list, with the bundled manifest as the labelled fallback in demo mode
  (site-spec.md "one source of truth"). The filter is **content bytes ≥ `FULLBLOCK_MIN_BYTES`** (3,500,000, the
  SDK `fullblock` tier floor), *not* `tierForSize`: historical Degents predate the mint's 3.9 MB cap and the very
  largest (~3.96 MB) are the truest block-fillers, so an upper bound would wrongly drop them. The chain only caps
  the block, not the artwork.
- `/exhibit/{n}` is one exhibit: a large plate, the one-block visualization, the recorded on-chain facts, a museum
  placard (inscription id, parent-linked provenance, timestamp), a curatorial note and the "why a full block is
  special" explainer, and the deep links below. Per-item `<title>`, OpenGraph and JSON-LD.
- **Honest empty state.** Real certified full-block counts may be 0. When no item qualifies, `/exhibit` shows a
  plain "none certified yet" panel and still teaches the concept — never a placeholder or invented item.

### 2. The one-block visualization (method + scale)

A single horizontal bar is one Bitcoin block: **its full width is 4,000,000 WU** (`LIMITS.MAX_BLOCK_WEIGHT` from
`@bsh/inscription`). The green fill's width is exactly the inscription's reveal weight as a fraction of that limit,
so **the fill's area *is* its weight** — the same weight-proportional idea as block.space's Block Theater
(ADR-0008 §3), reduced to one tile against the whole block. The fill width is `fraction × 100%`, the fraction is
`weight / 4,000,000`, and a component test asserts the rendered width equals the fraction within rounding; the e2e
re-checks it in a real browser. A table twin lists reveal weight, block limit, share and unused WU for screen
readers and reduced-motion; the bar is static (no animation).

**Weight is estimated, and labelled so.** We do not have the historical reveal transactions, only each item's
content length (from certification or the manifest). The exhibit feeds that length to
`@bsh/inscription.estimateRevealWeight` (the exact serializer the mint quotes and the service enforces — no maths
re-derived here) for a single-input, single-output JPEG-envelope reveal, and marks every derived number
`estimated: true`. Content bytes, and (from ord) block height, timestamp, address and fee, are the recorded facts.
Fee rate is `fee ÷ estimated vsize`. An **illustrative** cost at 2 sat/vB (via the existing `indicativeRevealSats`)
teaches "filling a block costs a block's worth of fees" without presenting a fixture fee as a real price.

### 3. Cross-links to the block.space tools (ADR-0008)

Each exhibit deep-links to **Transaction X-Ray** (`{blockspace}/xray/{revealTxid}`) and, once the block height is
known, **Block Theater** (`{blockspace}/theater?block={height}`), plus ordinals.com, Ordiscan and Magic Eden (Buy,
as elsewhere). The reveal txid is the txid half of the `{txid}i0` inscription id. The block.space base is
configurable (`VITE_BLOCKSPACE_URL`, default `https://block.space`); the Theater link is omitted (with a note)
until a height is available, rather than guessed.

### 4. Machine-native surface

- **Client twin:** `/exhibit?format=json` and `/exhibit/{n}?format=json` render the exact page data as JSON,
  computed by the same code path (consistent, offline).
- **Static twins:** a build step (`scripts/gen-exhibit.ts`, run before `vite build`) emits `dist/exhibit/index.json`
  and `dist/exhibit/{n}.json` from the bundled manifest (labelled `source: "bundled", certified: false`; a live
  deployment regenerates them server-side), plus `llms.txt` and `sitemap.xml` entries. Shapes are pinned by
  `schemas/exhibit-{item,index}.schema.json` and tested.
- **JSON-LD:** each item is a `VisualArtwork` with `contentSize` (bytes), `size` (WU + block share), `isPartOf`
  the collection `CreativeWork`, and a `citation` to the block. Stable anchors: `#plate`, `#one-block`, `#facts`,
  `#placard`, `#narrative`, `#why`.

### 5. Kiosk mode (`?kiosk=1`)

`/exhibit?kiosk=1` is a full-screen, auto-advancing show of plates with large type and the one-block viz, for a
gallery screen or booth. Auto-advance is **disabled under `prefers-reduced-motion`** (manual ← / → only, with an
on-screen hint) and the bar never animates. Demo mode makes no network requests.

## Alternatives considered

- **Classify by `tierForSize` (3.5–3.9 MB).** Drops the largest, most block-filling historical Degents. Rejected:
  the exhibit is about block-fillers; the tier floor is the honest filter.
- **Show a real per-item reveal weight from chain.** ord's inscription JSON has no reveal weight, and re-fetching
  and re-parsing each ~4 MB reveal is out of scope. The content-length estimate is exact for the envelope and
  clearly labelled; a follow-up can read the real weight from block.space's X-Ray API.
- **A byte-proportional bar.** Would hide the witness discount — the very thing that makes a full block possible.
  Weight-proportional, like Block Theater.
- **Invent curatorial lore tying to the comic.** Forbidden by site-spec.md; the comic copy was not captured. The
  narrative is a `TODO(copy)` placeholder that links to `/comic`.

## Consequences

- The exhibit inherits the site's single-source-of-truth rule: certified numbers or the labelled bundled manifest,
  never the retired live-site figures (4,027 / 1,470 MB) — enforced by tests.
- One more thing depends on `@bsh/inscription`'s sizing being exact; that is already asserted against real signed
  transactions in the platform.
- New env var `VITE_BLOCKSPACE_URL`. New build step emits static JSON/llms/sitemap into `public/` (git-ignored).
- When the first full-block Degent is certified, it appears automatically; until then the honest empty state shows.
