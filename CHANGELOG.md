# Changelog

## 0.2.0 — Unreleased

### Security

- `/api/proxy-image` is no longer an open proxy. Only https URLs on the
  hosts DALL·E returns (`oaidalleapiprodscus.blob.core.windows.net`,
  `oaidata.blob.core.windows.net`, `*.oaiusercontent.com`, `openai.com` and
  subdomains) are fetched; IP literals, private/loopback/link-local ranges,
  credentials, non-443 ports and redirects are rejected; body capped at
  10 MB; image content types only; cache shortened from one year to 5
  minutes; `Access-Control-Allow-Origin: *` removed.
- `/api/generate-frame` is protected: shared-secret header `x-atelier-key`
  when `ATELIER_API_KEY` is set, otherwise a per-IP sliding window of
  5 requests / 10 minutes. Body validation (JSON, string description ≤ 400
  chars). OpenAI errors are no longer echoed to the client.
- Security headers (`nosniff`, `X-Frame-Options: DENY`, referrer policy),
  `X-Powered-By` disabled.
- Next.js upgraded 14.2.5 → 14.2.35. `images.domains` → `images.remotePatterns`.

### Features

- Frame border width is a prop with a 5–25% slider (was hard-coded 15%).
- Output size is now a target (200–400 KB) rather than a raw quality value:
  a binary search over JPEG quality using real `canvas.toBlob` byte counts
  lands within ~2% of the target.
- Result card shows exact bytes, estimated inscription vbytes and the fee at
  1 sat/vB, and labels the output "Ready for the Degent mint (200–400 KB)".
- Frame prompt no longer asks DALL·E for a transparent centre (it cannot
  produce one); it asks for a flat dark panel the portrait covers.

### Design

- Rebranded to Degent Club tokens: `#0f0f10` background, Playfair Display
  headings and Inter body via `next/font`, gold `#d4a843` accent, orange
  `#f7931a` reserved for BTC/cost figures. Emoji headings removed.
- `QualitySlider` replaced by `OutputControls`.

### Tooling

- vitest suite: URL allow-list table (metadata IP, 10.x, localhost, http,
  lookalike hosts, allowed hosts), rate limiter, size-target search with a
  mocked `canvas.toBlob`, inscription estimate, border geometry.
- ESLint config (`next/core-web-vitals`), `npm run typecheck`, GitHub
  Actions CI running lint, typecheck, test and build.
- README rewrite, `docs/SECURITY.md`, `.env.example`.

## 0.1.0

- Initial release: DALL·E 3 frame generation, canvas combiner, quality slider.
