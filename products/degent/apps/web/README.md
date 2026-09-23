# @bsh/degent-web — the degent.club mint

The automated, non-custodial mint front end for the Decentralized Gentlemen Club (ADR-0002).
**What you see is what lands on chain:** the preview is rendered from the exact bytes that go into the
envelope, the SHA-256 is shown before upload and re-checked against ord after confirmation, and the
commit address is recomputed in the browser with `@bsh/inscription` before anything is payable.

```bash
pnpm --filter @bsh/degent-web dev        # http://localhost:5173  (add ?demo=1 for the full simulated flow)
pnpm --filter @bsh/degent-web test       # vitest + testing-library (jsdom)
pnpm --filter @bsh/degent-web typecheck
pnpm --filter @bsh/degent-web build      # → dist/
```

## Pages

| Path | What | Who |
|---|---|---|
| `/` | The mint wizard (below): Design → Mint → Confirm → Approve; Track shows the four stages, the live member tally ("2 of 3 members have approved"), the declined state with the parent-less reveal, and a share card once delivered | anyone |
| `/review` | The members' vote (ADR-0005): sign in with the wallet that holds a Degent (SIWB challenge from the mint, BIP-322 `signMessage` via `@bsh/wallet-kit`), grid of orders in `member_review` with preview, size and tier, Approve / Decline by signing `Approve Degent order <id> (<ref>)` | holders |
| `/explorer` | The Register: stats header (`/v1/stats`), filter/sort/paginated grid of every Degent (`/v1/explorer`), member detail | anyone |
| `/verify?tg=<token>` | Telegram gate landing: connect, sign the gate statement, POST `{token, address, message, signature}` to `VITE_GATE_URL` (the gate service is built separately) | holders |

Routing is a few lines in `src/router.ts` (pathname → route); `?demo=1` works on every page and seeds three
strangers' orders into the review queue.

Configuration adds `VITE_GATE_URL` (gate endpoint; empty disables `/verify`) and `VITE_SITE_URL` (share links).

## Flow

```
 Welcome ─► Connect ─► Create ─► Validate ─► Quote ─► Pay ───────────────────────► Track
 tiers,     wallet-kit  exact     mint-sdk    fee rate  1 Prepare                     poll GET /v1/orders/{id}
 live fees  ordinals vs bytes,    rules       breakdown   UTXOs (esplora)             ADR state timeline + tx links
 & queue    payment;    compress  locally,    lane/queue  funding PSBT + txid         verified → ord /content
            legacy      to tier   then PUT    ETA,        half-signed reveal (K_e)    side-by-side + "hash match ✓"
            refused     range,    content →   expiry,     POST /reveal                rescue_available → one-click
                        SHA-256,  art review  commit addr save recovery (localStorage)  rescue (service, or local
                        preview   (approved?) VERIFIED?   wipe K_e                      from the bundle)
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
   `buildHalfSignedReveal` (SIGHASH 0x83), `POST /reveal`, **save the recovery bundle**, **wipe `K_e`**.
4. The bundle is shown as copyable JSON (no download links) with a privacy warning; the user confirms they
   kept a copy.
5. `signAndBroadcast` — the wallet signs **without** broadcasting; we finalize, check the txid equals the one
   the reveal was signed against (a wallet that edits the tx would otherwise strand the funds), then broadcast
   via the wallet's `pushTx` or esplora `POST /tx`.

The wallet is never asked to sign before steps 3's reveal upload and recovery save have completed.

### Recovery bundle

`localStorage["degent.club/recovery/v1"]`: order id, network, API URL, funding txid/vout, commit value,
recipient, content hash, the half-signed reveal PSBT and the **order token**. No private key. It is the only
place the token is persisted; it never appears in URLs or logs. Anyone holding it can interfere with the
order (e.g. trigger rescue early), never redirect the Degent or funds — the UI says so.

Rescue (`rescue_available`): `GET /rescue` with the token; if the service is unreachable, the parent-less
`[commit] → [child]` reveal is built locally from the bundle (`@bsh/inscription.buildRescueReveal`) and
broadcast via wallet `pushTx` or esplora.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `VITE_MINT_API_URL` | `/api` | Mint service base URL (`/v1/...` is appended) |
| `VITE_NETWORK` | `mainnet` | `mainnet` \| `testnet` (testnet4) \| `signet` \| `regtest` |
| `VITE_ESPLORA_URL` | mempool.space per network | Esplora-compatible API for UTXOs and broadcast |
| `VITE_EXPLORER_URL` | `https://explore.block.space` | Block explorer for tx links (`/tx/<txid>`) |
| `VITE_ORD_URL` | `https://ordinals.com` | ord server for `/content/<inscription id>` |
| `VITE_POLL_MS` | `5000` (`1200` in demo) | Order polling interval |

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
| `src/screens/` | One component per step |

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
  order-token handling incl. missing-token errors; commit verification; rescue (service and local).
- `test/rules.test.tsx`, `test/quote.test.tsx` — rules display, review results, quote rendering (sats + BTC),
  commit-address mismatch blocking, Block Degent warnings, fee clamping and re-quote.
- `test/track.test.tsx` — timeline for every ADR status, delivered + hash match, rescue, resume from localStorage.
- `test/demo.e2e.test.tsx` — the whole flow through the UI in demo mode.

## Accessibility & design

Dark "private members' club" identity: lacquered bottle green, brass, ivory; Cormorant Garamond display,
Manrope UI, JetBrains Mono (tabular) for sats, bytes and hashes. Every control is labelled and keyboard
operable, focus moves to each step's heading, status changes are announced (`aria-live`), motion honours
`prefers-reduced-motion`, and the layout works down to 360–400 px.
