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
