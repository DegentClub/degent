# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Mint button could be clicked again after a successful payment and pay the
  same address twice. Orders are now a terminal state in the mint machine.
- Editing the fee rate during the debounce could pay the previous quote.
  Quotes are keyed by fee rate, file hash and recipient; the button is only
  enabled for an exact match.
- The chosen fee rate was not passed to UniSat `sendBitcoin`.
- Conflicting fee minimums (0.1 vs 0.13) unified to 0.13 with a 500 sat/vB max.
- "Calculating..." was shown while idle.
- Object URL leak in the image preview; compression race when the quality
  slider was moved quickly.
- Files under 200 KB got a misleading "increase quality" hint; the copy now
  explains that compression cannot enlarge a file.
- `alert()` calls replaced by an accessible toast.

### Added

- `lib/mint-machine.ts` pure reducer with unit tests.
- `lib/fees.ts`: fee bounds, cost estimate, mempool.space presets and BTC/USD
  price with graceful fallback; cost shown in sats, BTC and USD.
- `lib/address.ts`: checksum-verified mainnet address validation (bech32m,
  bech32, base58check).
- Wallet adapters for UniSat, Xverse, Leather, OKX and Magic Eden with a picker
  modal; mainnet enforced; taproot recipient required (with manual entry).
- Order tracking after payment (`components/OrderTracker.tsx`) persisted in
  localStorage; polls mempool.space; "Mint another" resets.
- Stepper header, keyboard-friendly quality slider, aria labels.
- Server route hardening: `SKRYBIT_API_KEY`, per-IP and per-recipient rate
  limits, recipient/fee/file validation, generic errors with request ids,
  `runtime = 'nodejs'`.
- `/api/health` endpoint.
- Vitest + Testing Library suite; `npm test`, `npm run typecheck`.
- GitHub Actions CI (lint, typecheck, test, build, docker build).
- Multi-stage non-root Dockerfile with `npm ci`, standalone output and
  `HEALTHCHECK`.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/skrybit-api.md`.

### Changed

- Fonts loaded through `next/font` instead of a CSS `@import`.
- Hero description is visible again.
- `NEXT_PUBLIC_AUTH_TOKEN` renamed to `SKRYBIT_API_KEY` (old name still
  accepted with a warning).
- `eslint-config-next` aligned with Next 14; `eslint` 8.

### Removed

- Dead code: `components/QualitySlider.tsx`, `components/StatusDisplay.tsx`,
  unused wallet logic in `Header.tsx`, root `7.jpg`, `DEBUGGING.md`.
- Unused dependencies `jimp`, `sharp`, `axios`.
- `build-instructions/` folded into `docs/skrybit-api.md`.
- Console logging of payment data.

## [2.0.1] - previous release

Initial Next.js rewrite with UniSat integration and Skrybit pay-to-address
flow.
