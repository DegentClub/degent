# Degen Minter

Mint a "Degent" Bitcoin Ordinals inscription from the browser. The app takes an
image, gets a quote from the [Skrybit](https://skrybit.io) API, asks the user's
wallet to pay the quoted amount to the quoted address, and then tracks the
payment until it confirms. Mainnet only.

Built with Next.js 14 (App Router), React 18, Tailwind 3 and TypeScript.

## How a mint works

1. **Connect** a wallet (UniSat, Xverse, Leather, OKX or Magic Eden). The app
   refuses anything that is not Bitcoin mainnet and needs a taproot (`bc1p`)
   address to receive the inscription; if the wallet's address is not taproot
   you paste one.
2. **Create**: upload a JPG/PNG/GIF/WebP and use the quality slider until the
   file is between 200 KB and 400 KB (a collection rule, enforced in the proxy).
3. **Review**: pick a fee rate (live presets from mempool.space, editable, 0.13
   to 500 sat/vB, confirmation above 50). The app fetches a quote from Skrybit
   for exactly these bytes, this recipient and this fee rate, and shows the
   total in sats, BTC and USD.
4. **Sign**: the wallet sends the quoted sats to the quoted payment address.
   The button is only enabled while the quote matches what is on screen, and it
   locks for good once a payment is sent.
5. **Track**: the txid, amount and Skrybit inscription id are stored in your
   browser and polled on mempool.space until the payment confirms. Skrybit
   reveals the inscription after that. "Mint another" starts a new order.

The state machine behind this is in `lib/mint-machine.ts`; see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the diagram and
[docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Environment variables

| Variable                 | Required | Description                                                                                       |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `SKRYBIT_API_KEY`        | yes      | Bearer key for `api.skrybit.io`. Server-side only.                                                |
| `SKRYBIT_API_URL`        | no       | Upstream base URL, default `https://api.skrybit.io`.                                              |
| `NEXT_PUBLIC_AUTH_TOKEN` | legacy   | Old name for the key. Still honoured with a one-time warning; rename it, the prefix is misleading. |

Copy `.env.example` to `.env.local` for local development.

## Run locally

```bash
npm ci
cp .env.example .env.local   # add your key
npm run dev                  # http://localhost:3000
```

Quote requests are proxied through `/api/inscriptions/create-commit`, so the
key never reaches the browser. mempool.space is called directly from the
browser for fee presets, BTC price and tx status; each falls back gracefully.

## Quality gates

```bash
npm run lint        # next lint (eslint-config-next 14)
npm run typecheck   # tsc --noEmit
npm test            # vitest (jsdom + Testing Library)
npm run build       # next build (standalone output)
```

The same four steps plus a Docker build run in GitHub Actions
(`.github/workflows/ci.yml`) on every push and pull request.

Tests live in `tests/` and cover the mint machine (no double pay, stale quotes
blocked, reset), fee handling, address validation (bc1p/bc1q/legacy, wrong
network, bad checksum), the rate limiter, order persistence and the key
components.

## Deploy

### Docker

```bash
docker build -t degen-minter .
docker run -p 3000:3000 -e SKRYBIT_API_KEY=... degen-minter
```

The image is multi-stage, runs as a non-root user on Node 22, ships only the
Next.js standalone output and exposes a `HEALTHCHECK` on `/api/health`.

### docker-compose

`docker-compose.yml` runs the app behind `nginx-proxy` with automatic Let's
Encrypt certificates for `mint.degent.club`. Provide `SKRYBIT_API_KEY` and
`DEFAULT_EMAIL` in the environment, then `docker compose up --build -d`.

### Scaling note

The rate limiter is in-process. Run one replica, or move the limiter to Redis
before adding more (details in `docs/SECURITY.md`).

## Project layout

```
app/
  page.tsx                          flow wiring (useReducer + quote effect)
  layout.tsx                        fonts (next/font), toast provider
  api/inscriptions/create-commit/   validating, rate-limited proxy to Skrybit
  api/health/                       liveness probe
components/                         Stepper, WalletConnect, WalletPicker, FileUpload,
                                    FileValidation, MintButton, OrderTracker, Toast, ...
lib/
  mint-machine.ts  fees.ts  address.ts  wallet.ts  api.ts  orders.ts  rate-limit.ts
tests/                              vitest suites
docs/                               ARCHITECTURE.md, SECURITY.md, skrybit-api.md
```

## Image requirements (Degent collection)

- Pepe in a tuxedo, bowtie mandatory.
- Must include the text "DEGEN", "DEGENT" or "REGEN".
- Final file 200–400 KB. Compression only shrinks files, so start from a large
  enough source.

## Links

- [Degent Club](https://degent.club)
- [Skrybit API facts](docs/skrybit-api.md)

## License

MIT
