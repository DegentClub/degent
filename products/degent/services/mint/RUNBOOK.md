# degent-mint runbook

Service: `@bsh/degent-mint`. Moves real bitcoin: read ADR-0002 before acting. Never widen the policy
signer to "get an order through". Never copy half-signed reveals out of the database: they are sensitive
until the reveal is confirmed.

Useful reads (no token needed): `GET /v1/health`, `GET /v1/queue`, `GET /v1/orders/{id}` (see `timeline`).
Logs are JSON lines; every transition logs `order transition` with `orderId`, `from`, `to`, `txid`.
Events: `degent.mint.order.<status>` on exchange `degent.mint`.

## 1. Stuck order

Identify where it is stuck from `status` and the last `timeline` entry.

| Status | Normal wait | If longer, check |
|---|---|---|
| `awaiting_content`, `approved`, `awaiting_payment` | until `quote.expiresAt` | Nothing to do; the worker expires it. A late commit is still honoured for 7 days (`LATE_PAYMENT_WINDOW_SECONDS`). |
| `paid`, `queued` | one tick, or the lane queue | `GET /v1/queue`: block lane holds one in flight per block. Health `parent` check: no parent UTXO pauses all reveals. A standard order waits while the parent comes from an unconfirmed Block Degent reveal (by design). |
| `revealing` | one tick | Logs `broadcast failed` for the order: retryable errors keep the parent lease and rebroadcast the same tx every tick (see section 4). `lastError` is in the store row. |
| `revealed` | ~1 block | Esplora `GET /tx/<revealTxid>`. If evicted, the worker re-pushes it every tick. If fees spiked, see section 3. |
| `confirmed` | until ord indexes | ord `GET /content/<inscriptionId>`; ord lagging is the usual cause. |
| `failed` | terminal | `timeline[-1].detail`: wrong commit value/script (user's wallet built the wrong funding tx; only the user's K_e could spend it, and K_e is discarded; escalate to support) or ord bytes differ (page someone: this should be impossible). |

Do not edit order rows by hand. If an order must be moved, do it through code with a test.

## 2. Parent key rotation

The parent key signs input 0 of every reveal; the parent inscription sits at the collection address.

1. Stop new orders: set `CORS_ORIGINS=` (empty) or take the API out of the load balancer; keep the worker running.
2. Wait until `GET /v1/queue` shows zero waiting and zero in flight on both lanes and no order is `revealing`
   (the parent lease must be free).
3. Move the parent inscription to the new key's taproot address with a normal ord send (outside this service),
   signed by the old key. Wait for 1 confirmation.
4. Deploy with the new signer key (KMS key id / dev `PARENT_KEY_FILE`), `COLLECTION_ADDRESS` = new address,
   and `PARENT_OUTPOINT` = the new parent location. `initialiseParent` only reads `PARENT_OUTPOINT` when the
   store has no parent, so also re-initialise the stored parent: call
   `StoreParentUtxoProvider.initialise(utxo, { force: true })` from a one-off script (it refuses while a lease
   is held). Startup refuses a `COLLECTION_ADDRESS` that is not the signer's address.
5. Restore traffic. The first reveal after rotation spends the new outpoint; verify its output 0 pays the new address.

Key compromise: stop the worker immediately (it is the only caller of the signer), then rotate as above.
User funds are never at risk from the parent key: every user can self-rescue.

## 3. Fee spike

- Quotes lock the reveal fee into the commit value, so paid orders cannot be re-priced. They still confirm
  when the mempool clears; low-fee reveals may take hours.
- The policy signer refuses fee rates outside the lane band (`DEFAULT_POLICY`: standard 1-2000, block
  1-500 sat/vB) and orders whose effective rate differs from the quote by more than 2%.
- To stop taking cheap orders during a spike, raise `MIN_FEE_RATE` and redeploy; new quotes reject lower rates.
- If a paid order will clearly not confirm before `RESCUE_AFTER_SECONDS`, do nothing special: after the timeout
  the worker offers rescue. The rescue tx is smaller than the parent reveal at the same fee, so its fee rate is
  higher.
- CPFP on the child output is the user's decision (their wallet owns output 1).

## 4. Lane broadcaster down

Symptoms: `broadcast failed` logs with `via` = `esplora` (standard) or `libre-relay` / `slipstream` (block),
orders held in `revealing`.

1. Check the backend directly (esplora `GET /blocks/tip/height`; Libre Relay `getnetworkinfo` via RPC; Slipstream status page).
2. Retryable failures keep the lease and rebroadcast the same bytes every tick. Nothing is lost; the same txid is reused.
3. Block lane: configure both `LIBRE_RPC_URL` and `SLIPSTREAM_URL` for fan-out (success if either accepts).
   Switching paths needs a redeploy only; orders in `revealing` pick up the new broadcaster on the next tick.
4. Permanent rejections (`bad-txns-*`, `missingorspent`, `dust`) release the lease and requeue the order. A
   repeating `missingorspent` on input 0 means the stored parent location is wrong: stop the worker, locate the
   parent (ord `/inscription/<PARENT_INSCRIPTION_ID>`), and re-initialise it as in section 2 step 4.
5. If the outage lasts past `RESCUE_AFTER_SECONDS` (default 6 h), affected orders become `rescue_available`.

## 5. Rescue

`rescue_available` means the service will not add the parent. The user's front end calls
`GET /v1/orders/{id}/rescue` with the order token (also held in their local recovery bundle) and broadcasts the
returned hex from any wallet or node. The inscription lands on the user's address without the parent link.

- Entered automatically after `RESCUE_AFTER_SECONDS` from payment, on a policy-signer refusal, or when the
  service fee output is missing from the funding tx.
- The worker watches the commit outpoint: when it is spent, the order moves to `revealed` with
  `rescued: true` (or `false` if our parent reveal won the race, in which case the parent chain is advanced)
  and then proceeds to `confirmed` -> `verified` -> `delivered` as usual.
- The service never broadcasts the rescue itself; the user does, so it stays their decision.
- Support cannot fetch a rescue without the order token. If the user lost both the token and the recovery
  bundle, the rescue tx is not recoverable by support; the half-signed reveal stays encrypted in the
  `reveals` table and must not be exported.

## Member review (ADR-0007)

- **Orders piling up in `member_review`.** Members are not voting. Check `GET /v1/review` with a holder session (or
  `GET /v1/stats` → `approvals.inReview`) and ping the club. Nothing is stranded: after `REVIEW_SLA_SECONDS`
  (default 14 days) the worker moves undecided orders to `rescue_available` and the front end offers the
  parent-less reveal. Lowering `APPROVAL_QUORUM` is a club decision, not an ops one.
- **Holder sign-in fails with `not_a_holder` for a known member.** The `roster-chain` registry could not see the
  Degent in the address's UTXOs: check `ORD_URL` serves `/r/utxo/<outpoint>` and `/r/inscription/<id>` (ord >= 0.18
  with `--index-addresses` not required) and that `ESPLORA_URL` lists the address's UTXOs. Answers are cached 60 s.
- **`auth_failed: domain_mismatch`.** `SIWB_DOMAIN` must equal the host the front end is served from (lower-case
  host[:port]); the challenge is bound to it.
- **Rotating `SESSION_KEY`.** Set a new key with a new `SESSION_KID`; sessions issued by the old key are refused
  after restart (TTL default 1 h), members simply sign in again.
- **Register update.** `node scripts/register-batch.mjs --db $DATABASE_PATH --since <last inscribed n> --out
  update.json`; the owner inscribes `update.json` as a child of the parent (docs/REGISTER.md §1.3).
