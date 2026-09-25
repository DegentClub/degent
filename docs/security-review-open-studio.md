# Security review: Open Studio money and upload paths (roadmap p5.5)

- **Scope:** `products/degent/services/mint/src/**` (order-service, worker, domain/policy, domain/quote,
  domain/royalty, remote-policy-signer, studio-client, ledger-client, esplora-chain, store-parent-utxo, admin.ts,
  config.ts), `products/degent/services/studio/src/**` (app.ts, application/studio-service, domain/artist,
  adapters), `products/degent/apps/web/src/{lib/funding.ts,flow/effects.ts,flow/studio.tsx,services/studioApi.ts}`,
  and the platform pieces at `deps/scribbit/platform/{inscription,ledger,signer,plane,identity,edge}/src` consumed
  by the above.
- **Method:** static reading of the code and its tests against the ten threat-model items below, adversarial
  reasoning about each money/trust boundary, and (for the one CONFIRMED item that was small and local) a
  failing-before/passing-after test plus a fix.
- **Not in scope / not modified:** `products/degent/apps/web` beyond the one client-side check that was already
  correct (no bug found there, so nothing was changed); the web app rebuild is owned elsewhere per the task brief.
- **Branch:** `claude/blissful-babbage-txtyys`, `deps/scribbit` pinned at `743221e`.

## Summary table

| # | Item | Verdict | Severity |
|---|---|---|---|
| 1a | Royalty/club-fee bypass: script vs address, multi-output summation, dust raise | checked-and-safe | - |
| 1b | Royalty/club-fee: RBF / unconfirmed handling | **CONFIRMED** | High |
| 2 | Edition reservation atomicity under concurrency | checked-and-safe (documented assumption) | Info |
| 3 | Attribution forgery (artist/artwork/edition in the envelope) | checked-and-safe | - |
| 4 | Payout address binding, legacy refusal, quote-time fixation | checked-and-safe | - |
| 5 | Upload path: sniffing, size limits, sha256, path traversal, unapproved content | checked-and-safe | - |
| 6 | Admin/internal endpoints: scope, key environment, replay | checked-and-safe | - |
| 7 | Remote signer: wrong-tx signature, replay | checked-and-safe | - |
| 8 | Order bearer tokens / IDOR | checked-and-safe (by contract) | Info |
| 9 | Ledger/plane: idempotency, one tx settling two intents, plane fail-open | checked-and-safe / N/A | - |
| 10 | Secrets: logging, webhook one-time secret, `SigningKey` redaction | checked-and-safe | - |
| 11 | Follow-up (not fixed): edition burn on a funding tx that never confirms | documented, proposed patch | Medium |
| 12 | Follow-up (not fixed): in-process locks assume a single mint replica | documented | Low/Info |

---

## 1a. Royalty/club-fee bypass — script comparison, summation, dust raise

**Verdict: checked-and-safe.**

`MintWorker.detectArtworkPayment` (`products/degent/services/mint/src/worker.ts:194-223`) calls
`checkFundingOutputs` (`src/domain/royalty.ts:35-56`), which:

- compares **scriptPubKey hex**, never address strings (`sumScript`, `royalty.ts:35-46`) — an attacker cannot
  dodge the check by paying an alternate encoding of the same address, and the worker cannot be fooled by a
  same-address-different-script coincidence;
- **sums every output** paying the artist/club script (`outputs.forEach`, `royalty.ts:39-43`), so splitting the
  royalty across several outputs (as the wallet's coin selection may legitimately do) still satisfies the check —
  proven by the "the royalty output may sit at any index and be split" test (`test/royalty-worker.test.ts:126-131`);
- **re-derives** the output indices from the funding transaction the chain backend returns
  (`tx.vout` in `worker.ts:198`), never trusts an index the client claims — `royaltyPaid.vout` is
  `check.artist.vouts[0]`, computed server-side (`worker.ts:205`);
- uses **`artistScriptHex`/`clubScriptHex`/`artistRoyaltySats`/`clubFeeSats` fixed on the order record at quote
  time** (`r.artistAddress`, `r.artistRoyaltySats`, `r.clubFeeSats`, set once in
  `application/order-service.ts:500-509` and never rewritten), so nothing the minter sends at payment time can
  change what is required;
- **dust raise** (`computeRoyaltySplit`, `packages/mint-sdk/src/rules.ts:346-368`) computes the exact
  `artistRoyaltySats` that is *both* quoted to the minter and checked by the worker — the same function, the same
  number, so there is no gap between "how much you were told to pay" and "how much is enforced" even when the
  raw royalty is below the payout script's dust limit.

A short or wrong-script payment moves the order to `rescue_available` with the parent never co-signed
(`worker.ts:212-217`, tests at `test/royalty-worker.test.ts:166-197`), and a self-rescue only ever reproduces the
same envelope (same attribution, same recipient) — it cannot be used to claim a Degent while stiffing the artist,
because the parent (the collection's own provenance mark) is exactly what a rescue lacks.

## 1b. Royalty/club-fee — RBF / unconfirmed handling — **CONFIRMED, fixed**

**Verdict: CONFIRMED. Severity: High. Fixed in this change.**

### The bug

`detectArtworkPayment` accepted a **mempool-only** sighting of the funding transaction as sufficient to:

1. move the order to `paid`,
2. **consume the edition reservation** (permanently — `EditionStore.consume`, comment: "Consumed ones stay
   forever (they are the editions)", `src/ports/edition-store.ts:44-49`),
3. record `royaltyPaid`, and
4. (via `enqueuePaid` → `dispatch`, same tick) actually **build, policy-sign and broadcast the parent-linked
   reveal**.

Separately, `reportRoyalties`/`reportRoyalty` decided whether it was safe to **tell the studio, and through it the
artist**, "you were paid X sats, edition N" based on a single flag:

```ts
// worker.ts (before this fix)
const fundingRbf = !tx.confirmed && tx.rbfSignalled;
```

```ts
// order-service.ts reportRoyalty (before this fix)
if (r.fundingRbf) {
  if (!funding) return r;
  if (!funding.confirmed && funding.rbfSignalled) return r; // still replaceable: pending
  ...
}
```

`tx.rbfSignalled` is BIP125 **opt-in** signalling only (`esplora-chain.ts:15-17`: "any input with sequence <
0xfffffffe"). It says nothing about whether the transaction can actually be replaced. Since Bitcoin Core 28.0
(October 2024) shipped default full-RBF mempool policy, essentially every relay and mining pool today will accept
a fee-bumping replacement of **any** unconfirmed transaction, whether or not it opted in. A transaction that does
**not** set a low sequence is, in the network as it actually runs today, just as replaceable as one that does — but
the code only deferred reporting for the opt-in case. The pre-fix test suite documented this directly: the
"full payment" test asserted `royalty.paid` emitted and the studio POSTed **after a single tick**, with the
funding transaction still at zero confirmations and not RBF-signalling (`fundArtwork()`'s defaults are
`confirmed: false, rbf: false`).

### Why this matters (and why it is not full fund theft)

The reveal itself stays safe: it is bound to the *exact* `commitOutpoint` (`{originalTxid, vout}`) of the funding
transaction the worker saw. If that transaction is replaced (a *different* txid, whether or not it opted into
BIP125) or simply evicted for low fees, that specific outpoint can never exist on chain, so the already-broadcast
reveal can never confirm and no Degent or parent provenance is actually handed to anyone who did not pay. So this
is **not** a path to co-signing a parent for an underpaying mint that then lands.

What it *does* cause:

- **A phantom royalty record and artist notification.** `reportRoyalty` emits `degent.mint.royalty.paid` and calls
  `POST /v1/internal/royalties` (which the studio uses to notify the artist by webhook/Telegram, ADR-0012 §6) for
  a payment that can still evaporate. The artist is told "your Degent was minted, edition #n, N sats paid in
  txid:vout" for a transaction that may never confirm.
- **A permanently burned edition on a limited-edition artwork.** `mintedEditions` is derived from royalty records
  (ADR-0012 §2), and the edition number itself is consumed (not released) the moment the mempool sighting happens
  — before any confirmation. An artwork with `maxEditions` set could show as sold out, or an edition number could
  be permanently unavailable, for a payment that never lands. (This half of the issue is the larger, not-fixed-here
  item — see §11 below.)
- This is squarely an Open Studio (Phase 3/ADR-0012) addition, not shared with plain (non-artwork) orders, and
  it is exactly what the review brief calls out by name ("RBF/unconfirmed handling").

### The fix

`worker.ts`: `fundingRbf` is now `!tx.confirmed` — *any* unconfirmed funding transaction is treated as still
replaceable for royalty-reporting purposes, regardless of the BIP125 signal. `order-service.ts`'s `reportRoyalty`
now waits for `funding.confirmed` alone, dropping the `&& funding.rbfSignalled` condition. This changes **only**
when the studio is told about the royalty (and the artist notified); it does not change when the order reaches
`paid`/`queued`/`revealing` or when the reveal is dispatched, which remains the existing 0-conf architecture shared
with plain orders (a larger change, out of scope for a small local fix — see §11).

Files changed:
- `products/degent/services/mint/src/worker.ts`
- `products/degent/services/mint/src/application/order-service.ts`
- `products/degent/services/mint/src/domain/order.ts` (comment only)

Tests: a new failing-before/passing-after test was added
(`test/royalty-worker.test.ts`, "security review p5.5: an unconfirmed, non-RBF-signalling funding tx must not be
reported or posted"), and the existing tests that asserted the old (unsafe) immediate-report behaviour were
updated to mine a block first where the test is specifically about reporting/posting, or to seed a confirmed
funding tx where the test is about something else (studio outage/retry/409 handling, editions, ledger). See
**Tests run** below for exact counts; the new/updated tests were confirmed to fail against the pre-fix code (see
commit-local verification note at the end of this document) before the fix was applied.

## 2. Edition reservation atomicity

**Verdict: checked-and-safe, with a documented deployment assumption.**

`MetaEditionStore` (`src/adapters/edition-store.ts`) serialises `reserve`/`consume`/`release` per artwork with an
in-process promise-chain mutex (`locked()`, lines 22-37), and the cap check
(`count >= opts.maxEditions` → `EditionsSoldOutError`) runs **inside** that same critical section that also picks
the edition number (lines 60-64), exactly as ADR-0012 §3 claims. `main.ts` runs the worker and the HTTP server in
**one Node process** (`main.ts:16-32`), so the mutex genuinely serialises every reservation, including the
concurrent-request case (two API requests interleave at `await`, which the mutex handles correctly). This is
tested with 2 and 8 concurrent requests (`test/artwork-orders.test.ts`, "reservations are per artwork" /
concurrency block) and matches.

**Caveat (not a code defect, an operational one):** the lock is in-process. `SqliteOrderStore.getMeta`/`setMeta`
(`src/adapters/sqlite-order-store.ts:74-80`) are plain read-then-write with no compare-and-swap, so if the mint
were ever horizontally scaled (more than one `degent-mint` process against the same database), two replicas could
both pass the cap check before either writes, overshooting `maxEditions`, and the parent-lease code
(`store-parent-utxo.ts`) has the identical assumption ("the worker additionally runs single-threaded"). This is
already documented in the code's own comments; there is no enforcement (e.g. an advisory lock or a startup check)
that stops an operator from accidentally running two replicas. Recommendation: if this is ever at risk of
happening operationally, add a `PRAGMA`/advisory-lock-based single-writer guard, or move the cap check to a
`UPDATE ... WHERE count < maxEditions`-style atomic SQL statement. Not fixed here (infra/process concern, not a
code path an external attacker can trigger).

## 3. Attribution forgery

**Verdict: checked-and-safe.**

The attribution triple (`artist`, `artwork`, `edition`, `studio`) is not just an API field — it is encoded as
canonical CBOR into the **envelope itself** (`deps/scribbit/platform/inscription/src/attribution.ts:182-191`,
`envelope.ts:104-109`) and is therefore part of the exact bytes the tapleaf script commits to. The commit address
is `commitAddress(pubkey, content, network)` where `content` includes the attribution
(`src/domain/quote.ts:65-67`, `computeQuote` at `quote.ts:74-133`), computed **server-side** from the order's own
`artistAddress`/`artworkId`/`edition` (`application/order-service.ts:479-488`, `contentOf` at
`order-service.ts:518-525`) — never from anything the minter's browser sends. `submitReveal`
(`order-service.ts:751-790`) rebuilds this exact `content` and calls `verifyHalfSignedReveal` with it; any
attribution mismatch changes the commit script, which changes the address the half-signed PSBT actually spends,
which the verifier rejects. A minter cannot inscribe someone else's artist address or a different artwork/edition
into an approved artwork's mint: doing so would require a different artwork order (a different `artworkId`), which
goes through the same server-side `payoutAddress` lookup (`mintableArtwork`, `order-service.ts:414-436`) — there is
no field on `POST /v1/orders` that lets a client set `artistAddress` directly (`parseCreateOrder`,
`order-service.ts:856-888`, only accepts `artworkId`, never an address).

Also: the bytes themselves cannot be swapped. `createArtworkOrder` fetches content from the studio and re-checks
`sha256Hex(bytes) === art.contentSha256` before storing it (`order-service.ts:450-460`); the reveal is built from
that stored copy, never from anything the minter uploads (studio-artwork orders skip the upload step entirely).

## 4. Payout address binding

**Verdict: checked-and-safe.**

- **BIP-322 proof bound to the session subject.** `updateMe` builds the signed message as
  `payoutMessage(payoutAddress, address)` where `address` is always `c.get('session').sub`
  (`services/studio/src/app.ts:155`, never taken from the request body), and the message template embeds it
  (`domain/artist.ts:90-94`: `"degent.club payout address <address> for <sessionSub>"`). A proof made for one
  artist's session cannot be replayed under another artist's session because the message differs.
- **Legacy addresses are refused before any royalty is quoted.** `updateMe` checks
  `PAYOUT_ADDRESS_KINDS = ['p2wpkh', 'p2tr']` and throws `payout_address_legacy` (422) *before* calling
  `verifyBip322Simple` (`application/studio-service.ts:404-414`) — a legacy address is refused outright, it never
  reaches a state where a royalty could be computed against it. The mint independently re-checks this at order
  time too (`payoutScriptTypeOf`/`mintableArtwork`, `order-service.ts:415-434`), so even a payout address stored
  by an older/misconfigured studio cannot produce a quote.
- **`artistAddress` is fixed at quote (order-creation) time**, not re-read from the studio afterwards.
  `createArtworkOrder` copies `art.payoutAddress` into the order record once
  (`artistAddress: art.payoutAddress`, `order-service.ts:503`), and every later use (`detectArtworkPayment`,
  `reportRoyalty`, `contentOf`/attribution) reads `r.artistAddress` off the order, never the studio again. An
  artist who changes their payout address between quote and payment cannot redirect an already-quoted royalty; the
  new address only applies to orders quoted after the change.

## 5. Upload path

**Verdict: checked-and-safe.**

- **Content-type sniffing vs declared type.** `RulesArtReview.review` calls `readImageInfo(bytes)` (real magic
  bytes) and fails the `magic_bytes` check when it disagrees with `declaredContentType`
  (`services/studio/src/adapters/rules-art-review.ts:15-28`); a mismatch means `approved: false`, so a
  content-type lie never reaches `approved` (and `GET /v1/artworks/{id}/content` only serves `approved` artworks
  with a `contentType` that, by construction, matched the real bytes).
- **Size limits / decompression bombs.** `bodyLimit` (`deps/scribbit/platform/edge/src/body-limit.ts`) rejects
  a declared `Content-Length` over the limit before reading anything, and streams-and-aborts for
  `Transfer-Encoding: chunked` bodies without a declared length (lines 12-40). The studio applies it at
  `svc.settings.maxUploadBytes` for `/v1/artworks/{id}/content` (`app.ts:167`) and the mint at
  `s.maxUploadBytes` for `/v1/orders/{id}/content` (`app.ts:224-228`). Neither service performs any
  transport-level decompression of request bodies (no gzip/deflate handling in either app or in `@bsh/edge`), so
  there is no decompression-bomb surface: the bytes stored are exactly the bytes received, bounded by the same
  limit.
- **sha256 mismatch handling.** Studio: `uploadContent` checks `bytes.length !== r.contentLength` before hashing,
  and stores `contentSha256` from the actual uploaded bytes, never from a client claim
  (`application/studio-service.ts:568-573`). Mint: `uploadContent` (plain orders) and `createArtworkOrder`
  (artwork orders) both re-hash the real bytes and 422 on any mismatch against the declared/artwork value
  (`order-service.ts:706-713`, `450-460`).
- **Path traversal in content-store keys.** Both `FsContentStore` implementations
  (`services/mint/src/adapters/content-stores.ts:14-17`, `services/studio/src/adapters/content-stores.ts:15-18`)
  derive the on-disk path from `sha256Hex(bytes)` — computed server-side from the actual content, never from a
  caller-supplied string — and additionally validate `isSha256Hex(sha)` before building any path, so even a
  corrupted/forged key can never contain `..` or other path metacharacters.
- **Unapproved content is never served.** `GET /v1/artworks/{id}/content` (studio) hard-checks
  `r.status !== 'approved'` and returns 404 otherwise (`application/studio-service.ts:624-630`) — a
  `submitted`/`reviewing`/`rejected`/`delisted` artwork's bytes are unreachable via this endpoint regardless of who
  asks (there is no privileged bypass on this specific route). Mint content (`/v1/orders/{id}/content`) has no
  public GET at all — only `PUT` (bearer-token gated) exists in the mint's OpenAPI surface, so raw order content
  is never served back over HTTP by that service either.

## 6. Admin/internal endpoints

**Verdict: checked-and-safe.**

- **`POST /v1/admin/parent/ack` (mint).** Requires an `@bsh/edge` API key of scope `mint:admin`
  (`admin.ts:35-53`); keys are configured hash-only (`MINT_ADMIN_API_KEYS_JSON`, `config.ts:210-233`, plaintext
  keys are explicitly rejected at config-parse time: `"contains a plaintext key"`, `config.ts:224`), and the
  configured `env` must equal `live` on mainnet / `test` elsewhere (`config.ts:229-230`). The handler requires the
  caller to name the **exact current** `outpoint`/`valueSats` (`admin.ts:67-76`,
  `acknowledgeValueChange` in `store-parent-utxo.ts:154-170`); a stale or blind acknowledgement (an old outpoint,
  or a guess) is rejected with 409 rather than closing the circuit breaker, so an attacker who obtained an old
  admin key/token cannot resume co-signing on a parent nobody actually re-verified.
- **`POST /v1/internal/*` (studio).** Both routes require scope `studio:internal`
  (`app.ts:198-202`, `SCOPE_INTERNAL`), enforced the same way (`apiKeys({ scopes: [SCOPE_INTERNAL], environment })`,
  `config.ts:117-121` / `apiKeyEnvironment` mainnet enforcement at `config.ts:113-114`). `recordRoyalty` is
  idempotent **and fact-checked** on `orderId` (`studio-service.ts:754-759`): a replay with the same facts is a
  no-op (`created: false`), a replay claiming *different* facts for an already-recorded order is refused with 409
  `conflict` rather than silently overwritten — so even a compromised or reused internal key cannot rewrite an
  existing royalty record's numbers, only create the one true record once.
- **Key environment (test vs live).** Both services refuse to start on `mainnet` unless every configured key
  (admin and API) is `env: live` (`services/mint/src/config.ts:146-147,209-230`,
  `services/studio/src/config.ts:113-114`), and the in-memory dev policy signer is refused on mainnet outright
  (`config.ts:146-147`).

## 7. Remote signer

**Verdict: checked-and-safe.**

`RemotePolicySigner.sign` (`adapters/remote-policy-signer.ts:164-187`) runs three independent gates, and the third
is the one that answers this threat directly: after the remote signer answers, the adapter **recomputes the exact
BIP341 key-path sighash for the transaction it is about to broadcast** (`full.preimageWitnessV1(...)`, line 174)
and requires the returned signature to verify against **that** digest under the collection's own output key
(line 181: `schnorr.verify(sig, digest, this.outputKey)`), and requires `sighashType === 0x00` and
`res.digest === hex.encode(digest)` (an exact match against what was asked, not just "a valid signature for
something"). SIGHASH_DEFAULT commits to every input and output of the transaction, so:

- the mint **cannot be tricked into broadcasting a different transaction than the one it asked the signer to sign**
  — any change to inputs/outputs after the fact would make the returned signature fail this local re-verification,
  and `finalizeReveal` builds the broadcast transaction from the exact PSBT the signature was checked against
  (line 185-186);
- a **replayed signature** is not exploitable: because the digest commits to the exact prevouts/amounts/outputs,
  reusing a signature for any other transaction would require an identical sighash preimage, i.e. an effectively
  identical transaction, which carries no new value to redirect.

The lean PSBT sent over the wire (`leanPsbt`, lines 216-227) deliberately strips input 1's leaf script (up to
3.9 MB of content), but keeps every prevout/output the signature must commit to, so nothing about the digest is
weakened by the trimming — confirmed by the local recomputation in gate 3, which uses the **full**, untrimmed
transaction (`full`, not the lean copy) to compute `digest`.

## 8. Order bearer tokens / IDOR

**Verdict: checked-and-safe.**

Every mutating/sensitive order endpoint is gated by `OrderService.authorize` (`order-service.ts:133-143`): a
constant-time (`timingSafeEqual`) comparison of the SHA-256 of the presented bearer token against the stored hash,
401 when absent/malformed, 403 on mismatch. `PUT /v1/orders/{id}/content`, `POST /v1/orders/{id}/reveal` and
`GET /v1/orders/{id}/rescue` all call it before doing anything order-specific (`app.ts:225-251`); the token itself
is a 32-byte random value returned once at order creation (`order-service.ts:362`) and never included in the
public projection (`toPublicOrder`, `domain/order.ts:65-91` has no token field).

`GET /v1/orders/{id}` is intentionally unauthenticated — this is a documented contract decision
(`contracts/openapi/degent-mint.yaml:157-167`: "Public order view (never includes the half-signed reveal or the
token)"), not an oversight, and order ids are `dgt_` + 12 random bytes (96 bits, `order-service.ts:123-125`), so
this is a capability-URL pattern (unguessable id = the access control), the same design many payment/order-status
pages use. It leaks status/price/recipient-address/timeline to anyone holding the id, but grants no ability to
*act* on the order (upload, reveal, rescue all still require the separate bearer token). No artwork order can be
created for an approved artwork and then have its content swapped afterwards: artwork-order content comes from the
studio at order-creation time and is never re-uploaded by the minter (§3, §5 above).

## 9. Ledger/plane

**Verdict: checked-and-safe for the ledger (used); N/A for plane (not used by degent yet).**

- **Idempotency-key collisions.** The platform ledger's `createOrder`/`createPsbtPayment` compare the fingerprint
  of the *current* request against any request stored under the same key and throw `422 idempotency_conflict` on a
  mismatch (`deps/scribbit/platform/ledger/src/service.ts:156-159,216-220`) — a key cannot be silently reused for a
  different request. The mint always derives its keys deterministically from `orderId`
  (`ledgerIdempotencyKeys`, `application/ledger-recording.ts`, used at `order-service.ts:549,554,564`), so retries
  are safe and two different orders never collide on the mint's side either.
- **One funding tx settling two intents.** The ledger explicitly guards this: before crediting a `psbt` intent by
  txid, it looks up every *other* payment already claiming that txid and refuses
  (`"txid ${update.txid} already settles ${other.id}"`, `service.ts:298-303`) — the first intent to record a given
  txid wins, and payouts are additionally idempotent on `(payment, txid, vout)`
  (`recordPayouts`, `service.ts:344-368`).
- **Plane fail-open on ESCALATE.** `@bsh/plane` is not imported or wired into any degent money path
  (`grep -rln '@bsh/plane' products/degent` returns nothing); the platform pin bump that introduced it
  (commit `1778cb1`, "signer parentReturn policy, `@bsh/plane`") is a platform-side dependency bump, not a
  consumption by this product. There is nothing in degent's code today for a plane fail-open behaviour to affect.
  Flagging for awareness if/when degent adopts `@bsh/plane`.

## 10. Secrets

**Verdict: checked-and-safe.**

- **Key material is never logged.** A repository-wide grep for `log.*(key|secret|token|psbt|apiKey|password)` in
  both services turns up only key **identifiers** (`keyId`, dev-key **ids**, not values) and boolean/absence
  warnings ("no SESSION_SIGNING_KEY configured" style), never a secret value
  (`services/mint/src/wiring.ts:96,135`, `services/studio/src/wiring.ts:68,86-87,92`,
  `adapters/remote-policy-signer.ts:182`). The half-signed reveal PSBT is deliberately kept out of the order row
  and out of every log line and API response (`domain/order.ts` header comment, lines 1-9) and encrypted at rest
  with AES-256-GCM, AAD-bound to the order id (`adapters/reveal-vault.ts:18-25`).
- **Webhook secret one-time semantics.** The per-artist webhook signing secret is generated on first webhook set
  or on `rotateWebhookSecret`, returned **once** in the `PUT /v1/artists/me` response
  (`notifyWebhookSecret`, `application/studio-service.ts:437-443,462`), and is not part of the artist's normal
  `Artist` projection (`toArtist`, `domain/artist.ts:65-81` only exposes `webhookSecretSet: boolean`). It is
  deleted when the webhook is removed (`applyNotify`, `studio-service.ts:453-454`).
- **`SigningKey` repr redaction.** `@bsh/identity`'s `SigningKey` (`deps/scribbit/platform/identity/src/session.ts:17-21`)
  is a plain `{ kid, secretKey: Uint8Array }` with no custom `toString`/`inspect` redaction. This is a latent risk
  *if* the object itself were ever passed to a logger, but a grep of both services' wiring/config code found no
  place where the `SigningKey` object (as opposed to its `kid`) is logged (`studio/src/wiring.ts:64-71`, only
  `cfg.sessionKid`/booleans are logged around it). No instance of an actual leak was found; noting the latent risk
  for defence in depth (a redacting `toJSON`/`[util.inspect.custom]` on `SigningKey` would remove the class of bug
  entirely, but this is a platform-repo change, out of scope here).

---

## 11. Follow-up (documented, not fixed): edition permanently burned by a funding tx that never confirms

**Severity: Medium. Not fixed in this change — larger than "small and local".**

Even after the §1b fix, `EditionStore.consume` is still called the moment a funding transaction is *seen* in the
mempool (`detectArtworkPayment`, `worker.ts:204`), before any confirmation, and a consumed reservation is never
released (`edition-store.ts` comment: "Consumed ones stay forever"). If that specific funding transaction never
confirms — evicted for low fees, or replaced by the minter's own wallet — the edition number it consumed is gone
forever, with no corresponding mint. On an artwork with `maxEditions` set, this is a real (if not cheap — the
attacker/unlucky minter must actually construct and broadcast a transaction paying the commit output) way to grief
an artist's limited-edition supply down without ever paying: repeat broadcasting-then-abandoning a slightly
low-fee funding transaction against the same or several artworks. With the §1b fix, at least the artist is never
*notified* of a payment that did not land, and no `mintedEditions` record is created for it — but the edition
number itself is still burned at `paid`, before the studio ever sees it (the mint's own `EditionStore` is separate
from the studio's `mintedEditions` counter).

**Proposed fix (not applied — needs a product decision, this is a behaviour change beyond a bug fix):**
delay `consumeEdition` (and the `paid` transition for *artwork* orders specifically) until at least one
confirmation, mirroring what this review's fix now does for royalty reporting, or add a background sweep that
notices a `paid` artwork order whose `commitOutpoint` transaction disappeared from the chain (evicted, not just
unconfirmed) and releases its edition back to the pool. The latter is more surgical (keeps the existing 0-conf UX
for everyone) but needs a new worker step and a decision about how long to wait before declaring a payment
"vanished" rather than "still pending." Either change affects the state machine / worker timing that dozens of
existing tests encode, so it deserves its own ticket and review rather than folding into this one.

## 12. Follow-up (documented, not fixed): in-process locks assume a single mint/studio replica

**Severity: Low / operational.**

See §2. `MetaEditionStore` and `StoreParentUtxoProvider` both rely on in-process serialisation and explicitly
document the "one worker, one API replica" assumption; nothing in the code enforces it. Recommend either an
explicit startup check (e.g. a leader-election lock row with a hostname/pid and a heartbeat) or moving the cap
check into an atomic SQL statement if there is ever a plan to run more than one `degent-mint`/`degent-studio`
process against the same database.

---

## Tests run

```
pnpm --filter @bsh/degent-mint test        # 288/288 passed (19 files) — includes 1 new test + 6 updated tests
pnpm --filter @bsh/degent-studio test      # 212/212 passed (15 files) — untouched by this review's fix
pnpm --filter @bsh/degent-mint typecheck   # clean
```

The new/updated royalty-reporting tests were verified to **fail** against the pre-fix worker/order-service code
(3 failures: the new test plus the two updated assertions that now require a confirmation) before the fix was
applied, and to **pass** after.

## Files touched

- `products/degent/services/mint/src/worker.ts` — `fundingRbf` now means "was unconfirmed when detected", not
  "was unconfirmed **and** BIP125-signalled".
- `products/degent/services/mint/src/application/order-service.ts` — `reportRoyalty` waits for confirmation
  alone, not confirmation-or-non-signalling.
- `products/degent/services/mint/src/domain/order.ts` — doc comment on `fundingRbf` updated to match.
- `products/degent/services/mint/test/royalty-worker.test.ts` — new regression test; existing "full payment" and
  "short club fee" tests updated to mine a block before asserting the report/post; "studio post failing" and "a
  non-retryable studio refusal" tests updated to seed an already-confirmed funding tx (they are about the studio
  POST retry loop, not confirmation gating).
- `products/degent/services/mint/test/artwork-e2e.test.ts` — "two artists, three mints" mines before checking
  royalty records; "a policy refusal on an artwork order" seeds a confirmed funding tx.
- `products/degent/services/mint/test/artwork-orders.test.ts` — "consumed editions count too" seeds a confirmed
  funding tx (the test is about the edition cap, not confirmation gating).

Nothing was committed or pushed, per the task brief.

## What was not changed

- No web app files were changed: `checkSignedFunding`/`compareOutputs`
  (`apps/web/src/lib/funding.ts:333-342`, `apps/web/src/flow/effects.ts:271-297`) already correctly compare every
  output's script and value, then the txid, before broadcasting a wallet-signed funding transaction — no client-side
  money bug was found there.
- Items 1a, 2 (core logic), 3, 4, 5, 6, 7, 8, 9, 10 needed no code change (checked-and-safe, with the noted
  operational caveats for §2 and §12, which are documentation/process recommendations, not code fixes).
