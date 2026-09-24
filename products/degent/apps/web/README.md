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
| `/review` | The members' vote (ADR-0007): sign in with the wallet that holds a Degent (SIWB challenge from the mint, BIP-322 `signMessage` via `@bsh/wallet-kit`), grid of orders in `member_review` with preview, size and tier, Approve / Decline by signing `Approve Degent order <id> (<ref>)` | holders |
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
- `test/demo.e2e.test.tsx` — the whole flow through the UI in demo mode.

## Accessibility & design

Dark "private members' club" identity: lacquered bottle green, brass, ivory; Cormorant Garamond display,
Manrope UI, JetBrains Mono (tabular) for sats, bytes and hashes. Every control is labelled and keyboard
operable, focus moves to each step's heading, status changes are announced (`aria-live`), motion honours
`prefers-reduced-motion`, and the layout works down to 360–400 px.
