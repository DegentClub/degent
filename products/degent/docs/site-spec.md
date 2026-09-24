# degent.club website: rebuild specification

Source: screenshots of the live WordPress site (`degent.club/collection/`, September 2026) plus the legacy
repos (`degen-minter-3`, `Degent-Marketplace`, `Degent-X-Bot`). The Manifesto and About page copy was not
captured; the builder must use placeholders marked `TODO(copy)` and never invent it.

## What the live site has (to replicate)

### Global chrome
- **Header** (sticky, black): logo mark (green gem/frog icon) + wordmark `degent` (white) `.club` (green);
  centre: two live meters once scrolled: `4,027 / 10K · 40.27% MINTED` and `1470MB / 3GB · 47.85% INSCRIBED`,
  each with a green→yellow progress bar; right: **Mint** (green→yellow gradient, rocket icon), **Buy** (dark,
  cart icon), hamburger menu. A thin green scroll-progress bar under the header.
- **Floating left rail** with social icons: Telegram, X, Instagram. "Back to top" chevron bottom-left.
- **Footer**: wordmark + "A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on
  Bitcoin."; Quick Links (Home, About, Minting Process, …); Newsletter ("Stay updated with our latest news
  and drops." Name + E-mail).

### Collection page (`/collection/`)
1. **Hero** over a darkened wall of framed Degents: pill badge `Degens`, H1 "The Collection" with a green rule,
   subtitle "Together we're minting bitcoin's biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising
   the standard on-chain.", buttons **Mint Now 🚀** (gradient) and **Learn How** (dark).
2. **Collection card**: badge `ORDINAL COLLECTION`, H2 "Decentralized Gentlemen Club", line "The BIGGEST Ordinal
   collection on Bitcoin! (10K = 3+ GB Blockspace)", stat pills `Supply: 10000 · Minted: 4027 · Blockspace:
   1470MB · Slug: degens`, buttons Website (gradient) / Twitter (dark) / Telegram (blue); right: Degent #1 in a
   gold frame with a `DEGEN` plaque.
3. **Grid**: "Showing 1–20 of 4027", per-page selector (20), full pagination toolbar (page select "1 of 202",
   first/prev, 1 2 3 4 … 202, next/last, "Go to" input). Six columns of gold-framed images, caption strip
   `DEGENT #N`.
4. **Lightbox** per item: image left; right: `DEGENT #5`, **Inscription ID** (full), **Address**, **Content
   type**, **Content length**, **Timestamp**, **Block height**, **Fee**, all fetched live from an ordinals API
   (they render "LOADING…" first); buttons **View on Ordinals.com** (gradient) and **Buy Item** (dark);
   prev/next arrows and a thumbnail filmstrip along the bottom.
5. **The Comic**: "This is Gentlemen- The Comic", "Learn the Degent Lore in this interactive comic book that is
   one of the biggest Bitcoin Ordinals in History.", buttons **Mint Now** and **View in Ordiscan**; cover art
   "THE DECENTRALIZED GENTLEMEN CLUB" (noir city, Pepe with martini, lightning).
6. **Degen Minter banner** over the grid wall: "Degen Minter", "Create Bitcoin Ordinals Inscriptions.", buttons
   **Mint Now!** and **Learn How**.

### Navigation (slide-out panel from the hamburger, right side)
Home · About · The Collection · Mint Process · Manifesto · Blog, each with a small green icon; a gradient
**Mint Now!** button at the bottom. Header buttons: Mint (→ `/mint/`), Buy (→ Magic Eden
`ordinals/marketplace/degentclub`). Socials: `x.com/degentclub`, Telegram `t.me/+cneroYQ-0VpmM2Ix`, Instagram.

### Blog (`/blog/`): "Degent Chronicles"
Hero over the grid wall: pill `Blog`, H1 "Degent **Chronicles**" (second word green), subtitle "Stories from the
blockchain, insights from the community, and updates from the Decentralized Gentlemen Club." Two-column post
cards with large cover art (e.g. a framed Pepe with a champagne glass; a "GO BIG OR GO HOME!" fireworks poster).
Posts are WordPress content; the rebuild needs a content source (markdown in-repo, or the existing WordPress
REST API `wp-json/wp/v2/posts` read at build time) — builder decides, documents it, and keeps the URL slugs.

### Mint process (`/mint/`)
A stats row (hidden under the header in the capture), then **Minting Rules**, "The essential requirements for
minting a Degent and joining the club.", as four check-marked cards:
1. **File Format & Size**: "Square JPEG format with a minimum size of 200KB."
2. **Essential Design**: "Pepe character wearing a tuxedo with a mandatory bowtie."
3. **Framing & Text**: "Must be framed and include a placard that says “DEGEN”, “DEGENT”, or “REGEN”."
4. **Quantity**: "Mint as many as you want – create your own mini-collection!"
Then an orange-accented callout **Did you know?** "All approved Degents become part of the official Decentralized
Gentlemen Club collection and are eligible for member-only benefits."
→ Rules the mint SDK must mirror: square aspect ratio, JPEG accepted (the SDK also allows PNG/WebP/AVIF/GIF —
keep JPEG as the recommended format and surface the others as accepted), framed + placard text is part of the
automated art review, no per-wallet cap.

### Visual identity
- Ground `#0b0b0d`; cards `#1a1a1d` / `#1b1b23`; borders `#2a2a2d`; text white / muted `#ffffffbd`.
- Accent **degent green `#2efc86`**; primary CTA gradient green → yellow/orange (approx `#2efc86` → `#f7c948`);
  Bitcoin orange `#f7931a` secondary; Telegram blue button `#1d4ed8`-ish.
- Type: a geometric grotesk (Space Grotesk or equivalent) for display and UI; mono for ids/numbers.
- Motifs: gold picture frames with a `DEGEN` plaque, hard offset shadows (`8px 8px 0 #00000040`), pill badges,
  green section rules.

## Known defects to fix in the rebuild (do not replicate)
- **Three conflicting counts**: site 4,027 minted / 1,470 MB; `collection.json` 4,112; internal analysis 4,113 /
  1,508 MB. The rebuild reads **one** source: the block.space certification attestation
  (`@bsh/blockspace-certify` → `GET /v1/collections/degents`), with the manifest as fallback in demo mode.
- "10K = 3+ GB" is a projection presented as fact; show projected vs certified explicitly.
- Item details are fetched client-side per lightbox open with visible "LOADING…"; prefetch and cache.
- Newsletter form posts to WordPress; the rebuild uses `@bsh/notify` subscriptions (email channel).
- Three properties (WordPress, mint.degent.club, marketplace) → one app.

## Target information architecture (one app: `@bsh/degent-web`)
```
/                 Home: hero wall, certified stats, live mint meters, the comic, latest mints, CTA
/collection       Gallery (certified membership), pagination, filters (tier, size, number), lightbox with
                  on-chain details from ord (+ block.space attribution), "View on ordinals.com", "Buy" (Magic
                  Eden link until first-party trading ships)
/collection/:n    Deep link per Degent (shareable, OpenGraph image)
/mint             The automated mint (existing flow)
/comic            The comic (embedded on-chain content via ord /content, with reader controls)
/manifesto        TODO(copy)
/about            TODO(copy)
/how-it-works     "Minting Process" / "Learn How": tiers, fees, wallets, what happens after payment
/club             Holder area: sign in with Bitcoin (Blockspace ID), your Degents, perks (placeholder)
```

## Implementation status

Where each item above stands in `@bsh/degent-web` (routes and tests: `products/degent/apps/web/README.md`;
roadmap ids in `roadmap.yaml`). **done** = shipped with tests; **todo** = open, with the reason.

### Global chrome (roadmap p2.30)
| Spec item | Status | Notes |
|---|---|---|
| Sticky black header, gem mark + `degent` / `.club` wordmark | done | `src/site/chrome.tsx` |
| Two live meters (minted / 10K, MB / 3 GB) with green→yellow bars | done | always shown on wide screens (hidden under 1000 px); read from `/v1/stats`; the 3 GB is labelled a projection |
| Mint (gradient, rocket) and Buy (dark, cart → Magic Eden) | done | `VITE_BUY_URL` |
| Hamburger → slide-out nav with Mint Now! at the bottom | done | modal dialog, focus trapped; links: Home, About, The Collection, Mint Process, Manifesto, The Comic, The Club, The Register, Member review |
| Blog link in the nav | todo | no blog yet (p2.39) |
| Thin green scroll-progress bar | done | |
| Floating left rail (Telegram, X, Instagram), back to top | done | Instagram hidden until `VITE_INSTAGRAM_URL` is set (URL not captured) |
| Footer: wordmark, tagline, quick links | done | |
| Footer newsletter (Name + E-mail) | todo | form ships disabled: the mint API has no newsletter endpoint yet (p3.30); per-order "Notify me" is live |

### Collection page (p2.32, p2.33)
| Spec item | Status | Notes |
|---|---|---|
| Hero over the framed wall: `Degens` pill, "The Collection", green rule, subtitle, Mint Now / Learn How | done | |
| Collection card: badge, H2, line, stat pills, Twitter / Telegram buttons, Degent #1 in a gold frame with plaque | done | "Website" button dropped (this is the website); "10K = 3+ GB" shown as *projected* next to the *certified* MB |
| Grid: "Showing 1–20 of N", per page, page select "1 of N", first/prev, numbers with …, next/last, "Go to" | done | six columns on desktop, caption `DEGENT #N` |
| Filters (tier, size, number) | done | server-side (`/v1/explorer` `tier`, `minBytes`, `maxBytes`, `q`; p2.40) so counts stay honest |
| Lightbox: inscription id, address, content type, content length, timestamp, block height, fee; View on Ordinals.com; Buy Item; prev/next; filmstrip | done | ord `/r/inscription` prefetched per page and cached: no "LOADING…" flash; keyboard: Esc, ←/→, Tab trapped |
| block.space attribution in the lightbox | todo | shows "the Register" as the membership source; block.space certification is p2.41 |
| `/collection/:n` deep link | done | title, OpenGraph/Twitter tags and JSON-LD client-side |
| OpenGraph image per Degent | todo | unfurlers do not run JavaScript: needs an edge function / prerender (p2.12; README "Share cards") |
| The Comic section | done | teaser on Home; `/comic` page (p2.34); the comic's inscription id is an owner setting (p2.35) |
| Degen Minter banner | done | on Home |

### Other pages
| Spec item | Status | Notes |
|---|---|---|
| `/` Home | done | p2.31 |
| `/mint` the automated mint | done | the wizard moved from `/` to `/mint`; the Atelier lives in its Create step (p1.7) |
| Mint process → `/how-it-works` | done | the four Minting Rules (verbatim), "Did you know?", tiers, live fees, wallets, stages, review, self-rescue, recovery bundle (p2.36) |
| Minting rules mirrored by the SDK | done | square + tier size + allowed types measured; JPEG recommended, others accepted; design and placard self-attested or measured by the Atelier; no per-wallet cap |
| `/comic` | done | ord `/content` embed with zoom, full screen, page-by-page reader; placeholder until configured |
| `/club` | done | SIWB sign-in (the mint's holder session), your Degents, links to /review and the Telegram gate; perks TODO(copy) (p2.37) |
| `/manifesto`, `/about` | todo | TODO(copy) placeholders: copy not captured, not invented (p2.38) |
| `/blog` "Degent Chronicles" | todo | content source to decide; slugs to keep (p2.39) |
| Visual identity | done | `src/site.css` (ground, cards, borders, green, CTA gradient, orange call-out, gold frames, Space Grotesk + mono) |

### Known defects
| Defect | Status | Notes |
|---|---|---|
| Three conflicting counts | done | one source for the whole site: the Register's `/v1/stats` (demo: the fakes); moving that source to the block.space attestation is p2.41 |
| "10K = 3+ GB" presented as fact | done | shown as projected, next to the certified MB |
| Lightbox "LOADING…" per open | done | prefetch + cache |
| Newsletter posts to WordPress | todo | p3.30 (per-order notifications via `@bsh/notify` are live: p1.31, p1.32) |
| Three properties → one app | done for site + mint | first-party trading is the marketplace work (p3.x); "Buy" links out until then |
