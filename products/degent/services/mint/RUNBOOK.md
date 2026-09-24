# degent-mint runbook

Service: `@bsh/degent-mint`. Moves real bitcoin: read ADR-0002 and ADR-0005 before acting. Never widen the policy
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
| `paid`, `queued` | one tick, or the lane queue | `GET /v1/queue`: the block lane fills one block at a time up to `weightBudget` (3,990,000 WU; compare `inFlightWeight`); a Full Block Degent always has a block alone, and nobody overtakes the first order that does not fit. Health `parent` check: no parent UTXO pauses all reveals. Log `parent UTXO value differs from PARENT_VALUE_SATS`: all reveals paused, see section 2. A standard order waits while the parent comes from an unconfirmed block-lane reveal (by design). |
| `revealing` | one tick | Logs `broadcast failed` for the order: retryable errors keep the parent lease and rebroadcast the same tx every tick (see section 4). `lastError` is in the store row. |
| `revealed` | ~1 block | Esplora `GET /tx/<revealTxid>`. If evicted, the worker re-pushes it every tick. If fees spiked, see section 3. |
| `confirmed` | until ord indexes | ord `GET /content/<inscriptionId>`; ord lagging is the usual cause. |
| `failed` | terminal | `timeline[-1].detail`: wrong commit value/script (user's wallet built the wrong funding tx; only the user's K_e can spend it, and K_e is in the user's recovery bundle: support can guide them to spend it with `@bsh/inscription` tooling, never ask for the bundle) or ord bytes differ (page someone: this should be impossible). |

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
   The new parent UTXO must carry exactly `PARENT_VALUE_SATS` (startup refuses otherwise). Every stored
   half-signed reveal has output 0 signed to the OLD `COLLECTION_ADDRESS` and value (ADR-0005 §1), so the
   queue MUST be empty (step 2) and no order may sit in `approved`/`awaiting_payment` either: wait for them
   to expire or be paid and revealed before rotating. Changing `PARENT_VALUE_SATS` is a rotation too.
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
`GET /v1/orders/{id}/rescue` with the order token (also held in their recovery bundle), gets the rescue INPUTS,
checks them against the bundle, re-signs `[commit] -> [child]` locally with the one-time key K_e from the bundle
(ADR-0005 §2) and broadcasts it from the wallet or esplora. The inscription lands on the user's address without
the parent link. The service cannot build or sign a rescue: it never has K_e.

- Entered automatically after `RESCUE_AFTER_SECONDS` from payment, on a policy-signer refusal, or when the
  service fee output is missing from the funding tx.
- The worker watches the commit outpoint: when it is spent, the order moves to `revealed` with
  `rescued: true` (or `false` if our parent reveal won the race, in which case the parent chain is advanced)
  and then proceeds to `confirmed` -> `verified` -> `delivered` as usual.
- The service never broadcasts the rescue itself; the user does, so it stays their decision.
- The bundle alone is enough: the front end rescues even when the service is down. If the user lost the
  bundle, nobody (including support) can spend the commit output; the parent reveal can still happen if the
  service recovers, because the half-signed reveal is stored. Never ask a user to send their bundle (it holds
  a key); point them at the Rescue button or the documented `buildResignedRescue` call.
- The half-signed reveal stays encrypted in the `reveals` table and must not be exported.
