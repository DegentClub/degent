# Changelog

## 1.1.0 — Unreleased

### Security

- Startup validation (`src/config/validate.js`): production refuses to boot
  with placeholder or missing `JWT_SECRET` / `ADMIN_PASSWORD`, or the
  built-in `dgentx:dgentx` database URL. Test runs need
  `ALLOW_INSECURE_DEFAULTS=true` to bypass; development only warns.
- `docker-compose.yml` no longer publishes Postgres (5432) or Redis (6379) on
  the host, requires `POSTGRES_PASSWORD` and `REDIS_PASSWORD` from `.env`,
  runs Redis with `--requirepass`, adds healthchecks to every service and
  binds the API to `127.0.0.1`.
- Wallet-address filter now actually matches bech32/bech32m (`bc1q…`,
  `bc1p…`, case-insensitive), P2SH (`3…`) and P2PKH (`1…`). The previous
  `\bbc1\b` pattern could never match a real address.

### Content safety

- New approval-tier classifier (`src/lib/content-classifier.js`):
  `classifyContent(text)` → `auto` | `review` | `manual`. Financial language
  (dollar amounts, floor/price, `Nx`, guaranteed, ROI, invest, "at
  completion", token talk) is `manual`; numeric facts and announcements are
  `review`; memes and replies are `auto`.
- `post-content` inserts generated content with the classified tier and
  `status: 'pending'` unless the tier is `auto` and `REVIEW_QUEUE_ENABLED`
  is `false`. Previously every generated tweet was inserted as
  `approved` / `auto`, bypassing the review queue.
- Manual-tier rows marked `approved` without an `approvedBy` are refused by
  the poster.
- `appendDisclaimer()` adds "NFA." only to review-tier market talk; it never
  laundries manual-tier content.
- The Telegram bridge classifies captions too; the stricter tier wins.

### Brain

- `brain/DEGENT_X_BOT_BRAIN.md` v2.1 is the single copy (root file is a
  pointer; loader no longer falls back to it). Floor-value projections and
  "$X at completion" talking points are retired in favour of heritage
  framing ("written in the 0.13 sat/vB era", "1.5 GB and counting", "verify
  it with a node"). Institution is the Decentralized Gentlemen Club; a
  member is a Degent.

### Tooling

- vitest suite (`npm test`) covering config validation, the address regex,
  the classifier, the safety gate and the post-content job with mocked
  DB/queue.
- GitHub Actions CI.
- `docs/OPERATIONS.md`.

## 1.0.0

- Initial release.
