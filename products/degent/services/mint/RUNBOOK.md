# degent-mint runbook

Service: `@bsh/degent-mint`. Moves real bitcoin: read ADR-0002 and ADR-0005 before acting. Never widen the policy
signer to "get an order through". Never copy half-signed reveals out of the database: they are sensitive
until the reveal is confirmed.

Useful reads (no token needed): `GET /v1/health` (checks `store`, `chain`, `parent`, `bus`, `signer`, and
`parentValue` while the parent value breaker is open), `GET /v1/queue`, `GET /v1/orders/{id}` (see `timeline`).
Logs are JSON lines; every transition logs `order transition` with `orderId`, `from`, `to`, `txid`. Alerting keys
on the structured `event` field: `parent.lease.changed` (info), `parent.value.changed` (error, page),
`event.publish.failed` / `event.publish.lost` (error), `bus.lost` (error).
Events: CloudEvents on the platform topic exchange `AMQP_EXCHANGE` (default `bsh.events`), routing key = type:
`degent.mint.order.<status>`, `degent.mint.royalty.paid`, `collection.minted` (section 9).

## 1. Stuck order

Identify where it is stuck from `status` and the last `timeline` entry.

| Status | Normal wait | If longer, check |
|---|---|---|
| `awaiting_content`, `approved`, `awaiting_payment` | until `quote.expiresAt` | Nothing to do; the worker expires it. A late commit is still honoured for 7 days (`LATE_PAYMENT_WINDOW_SECONDS`). |
| `paid`, `queued` | one tick, or the lane queue | `GET /v1/queue`: the block lane fills one block at a time up to `weightBudget` (3,990,000 WU; compare `inFlightWeight`); a Full Block Degent always has a block alone, and nobody overtakes the first order that does not fit. Health `parent` check: no parent UTXO pauses all reveals. Log `parent UTXO value differs from PARENT_VALUE_SATS`: all reveals paused, see section 2. Health `parentValue` false / log `parent.value.changed`: co-signing paused until acknowledged, see section 8. Health `signer` false / `remote signer unavailable`: see section 7. A standard order waits while the parent comes from an unconfirmed block-lane reveal (by design). |
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
4. Deploy with the new signer key (`SIGNER_KEY_ID` on the platform signer, section 7 / dev `PARENT_KEY_FILE`),
   `COLLECTION_ADDRESS` = new address, and `PARENT_OUTPOINT` = the new parent location. `initialiseParent` only
   reads `PARENT_OUTPOINT` when the store has no parent, so also re-lease the stored parent with the one-off in
   section 8 step 5 (it refuses while a lease is held). Startup refuses a `COLLECTION_ADDRESS` that is not the
   signer's address (`SIGNER=remote`: the preflight asks the signer for the key).
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

## 6. Artwork orders and royalties (Open Studio)

An artwork order (`GET /v1/orders/{id}` has `artworkId`) pays the artist and the club inside the minter's own
funding transaction: outputs `[commit, artist royalty, club fee, change]`. Nothing here is custodial: the
service verifies outputs, it never moves money. Read ADR-0007 §5 before acting.

| Symptom | Meaning | Action |
|---|---|---|
| `rescue_available` right after `paid`, detail `funding transaction does not pay the studio split: ...` | The wallet-built funding tx is short of, or missing, the artist or club output (compared by script). The parent is never co-signed for it. | Nothing to fix on our side: the user self-rescues (section 5). If the artist output WAS paid, `royaltyPaid` is set and the studio still gets the record. A wallet that keeps producing this needs the web app's post-sign check looked at. |
| `rescue_available` with detail `edition N was released when the quote expired and taken by another order` | The user paid after the quote expired and another order took the number their reveal was signed with. | User self-rescues (the inscription lands without the parent link; its metadata carries edition N, the collection's edition N is the other order). No manual fix. |
| `royaltyReport.lastError` in the store row, `royalty record not accepted by the studio; will retry` logs | Studio unreachable or 5xx. | Retried every tick after a 30 s -> 1 h backoff; nothing is lost. Check the studio's health. |
| `studio refused the royalty record; operator attention needed` (`royaltyReport.gaveUp: true`) | The studio answered a non-retryable status (409 = a record for this `orderId` with different facts, 404 = artwork gone). | Compare the order's `royaltyPaid` with `GET /v1/artists/me/royalties` on the studio side. Never edit either row by hand; if the facts on chain are right, the studio record is the one to correct through its API. |
| `ledger recording failed; will retry` / `ledger observation failed; will retry` | Ledger down. Ledger recording never blocks a mint. | Retried with backoff. The ledger also finds the transaction itself by payee script once it is back. |
| Artwork orders refused with 422 "no studio configured" | `STUDIO_URL` unset. | Set `STUDIO_URL` + `STUDIO_API_KEY` (scope `studio:internal`) and `SERVICE_FEE_ADDRESS` when a club fee is set. |
| Every artwork order is 409 `artist_payout_missing` | The studio does not expose the artist's proven payout address to the mint (or the artist has not proven one). | Artists prove a payout address in the studio (`PUT /v1/artists/me`); the studio must expose it to the mint's key. |

Money facts to remember: the royalty base is the mint price (commit value + club fee), `ROYALTY_BPS` default
10%; a royalty below the payout script's dust limit is raised to it (the quote says `royaltyRaisedToDust`). The
`degent.mint.royalty.paid` event and the studio record are emitted once per order after the funding transaction
is final (confirmed, or unconfirmed and not RBF-signalling). Changing `ROYALTY_BPS` / `CLUB_FEE_BPS_*` affects
new quotes only; paid orders are verified against the split they were quoted.

## 7. Remote policy signer (`SIGNER=remote`)

The collection parent key lives in the platform signer service (`@bsh/signer`, platform
`contracts/openapi/signer.yaml`); the mint only holds an API key. Mainnet starts ONLY with `SIGNER=remote`
(`SIGNER=memory` is refused there, `SIGNER=kms` is retired and refused everywhere).

Mint side: `SIGNER=remote`, `SIGNER_URL` (private network), `SIGNER_API_KEY` (secret
`services/degent-mint/signer-api-key`, `bsh_live_…` on mainnet), `SIGNER_KEY_ID` (e.g. `degent-parent`),
`SIGNER_TIMEOUT_MS` (10 s), `SIGNER_RETRIES` (2), `COLLECTION_ADDRESS`. Startup preflight: the signer answers,
its `network` equals `NETWORK`, and `p2tr(SIGNER_KEY_ID) == COLLECTION_ADDRESS`; otherwise `startup refused`.

Every co-signature passes three gates: (1) the mint's own `evaluateParentPolicy` (ADR-0002 §3, exact shape)
BEFORE any network call; (2) the signer's policy; (3) the mint verifies the returned signature against the
sighash it computed itself for the transaction it will broadcast. The mint sends a lean PSBT (prevouts and
outputs, no leaf script or artwork): a few hundred bytes, well under the signer's 256 KiB body limit.

### Signer configuration the operator sets (dedicated instance for the parent key)

Run a **dedicated signer instance** for the degent parent key: the signer's env policies apply to every key an
instance serves. Exactly this (the test suite builds the signer from the same settings,
`test/fakes/remote-signer.ts`):

| Variable | Value | Why |
|---|---|---|
| `SIGNER_NETWORK` | same as the mint's `NETWORK` | the mint's preflight refuses a mismatch |
| `SIGNER_KEY_PROVIDER` / `SIGNER_KEY_IDS` | `env` / `degent-parent` (`SIGNER_KEY_DEGENT_PARENT` from `services/signer/keys/degent-parent`; an HSM provider when wired) | the untweaked key; `p2tr(key)` is `COLLECTION_ADDRESS` |
| `SIGNER_ALLOWED_SIGHASH` | `0x00` | the parent input is signed SIGHASH_DEFAULT (commits to every input and output); nothing else is ever needed |
| `SIGNER_MAX_INPUT_SATS` | `PARENT_VALUE_SATS` (10000) | the key may only spend a UTXO of the parent's size: coins sent to the collection address stay unspendable by this path |
| `SIGNER_MAX_FEE_SATS` | `508725000` with `DEFAULT_POLICY` | = max over lanes of `ceil(maxWeight/4) × maxFeeRate × (1 + feeRateTolerance)` (block: 997,500 vB × 500 × 1.02). Recompute whenever the mint's bands change; the fee is paid by the user's commit input, never by the parent |
| `SIGNER_OUTPUT_ALLOWLIST` | **unset** | output 1 pays each minter; an allowlist (every output must match) would refuse every reveal |
| `SIGNER_ALLOWED_PURPOSES` | empty | no digest signing with the parent key |
| `SIGNER_API_KEY_ENV` | `live` on mainnet (`test` elsewhere) | |
| `SIGNER_API_KEYS_JSON` | `[{"id":"degent-mint","hash":"<sha256 of SIGNER_API_KEY>","env":"live","scopes":["sign:degent-parent"]}]` | `sign:<keyId>` also covers the preflight's pubkey read; no `audit:read` for the mint |
| `HOST`, ingress | private interface; mTLS in front (platform signer README "Transport") | the API key is identity, not the perimeter |
| `SIGNER_MAX_BODY_BYTES` | default (256 KiB) | lean PSBTs are < 2 KB |

What the signer does NOT check with env policies alone: that output 0 returns the parent to the collection
address with the same value. The mint checks it (gate 1) and the browser's 0x81 signature pins it, but the
signer cannot express it at pin 09bd9d7 (follow-up: a `parentReturn` taproot policy in DegentClub/scribbit,
wired in the signer's `main.ts`). Never widen the mint's policy to match the signer; tighten the signer.

### Symptoms

| Log / health | Meaning | Action |
|---|---|---|
| `remote signer unavailable; retrying`, then `…; giving up for this tick`; health `signer` false | network error, timeout, 429 or 5xx (retried `SIGNER_RETRIES` times; re-signing the same unsigned tx is safe, the txid does not change) | Orders stay `queued` and the lease is released; nothing is lost. Check `GET <SIGNER_URL>/v1/health`, fail over (below). After `RESCUE_AFTER_SECONDS` users self-rescue. |
| `remote signer rejected the request (configuration or request error; not retried)` with 401/403 `insufficient_scope`/404/422 | API key revoked/rotated, scope missing, wrong `SIGNER_KEY_ID`, key/address mismatch | Fix the configuration; orders wait in `queued`. |
| `policy signer refused` with `stage: remote` | the signer's policy denied what the mint's accepted: a policy MISMATCH | The order went to self-rescue (a denial is a decision, never retried). Read the signer audit (`GET /v1/audit?decision=deny`, scope `audit:read`), bring the signer config back to the table above. |
| `remote signer returned a signature that does not verify for this reveal` | the signer signed something else | Page. Stop the worker; treat as a signer compromise or bug. Nothing was broadcast. |
| `startup refused … remote signer preflight failed` | signer down, wrong network, or its key is not `COLLECTION_ADDRESS` | Fix before starting; the mint never serves with an unverified signer. |

### Failover (rehearse on signet, p5.6)

Keep a standby signer instance with the same key id and configuration. To fail over: point `SIGNER_URL` (or the
DNS name / load balancer behind it) at the standby and restart the mint; the preflight re-verifies the key. While
the signer is down the mint keeps accepting orders and detecting payments; reveals resume on the first tick
after the signer answers. Rehearsal: stop the primary signer, watch health `signer` go false and orders stay
`queued` (none `rescue_available` before the timeout), switch, watch the queue drain, compare the signer audit
log with the reveals broadcast.

## 8. Re-leasing or re-initialising the parent

**Why the value is pinned.** Since ADR-0005 the browser signs the reveal SIGHASH_ALL|ANYONECANPAY (0x81) over the
outputs `[parent return = (COLLECTION_ADDRESS, PARENT_VALUE_SATS), child]` before the mint adds the parent
input. ord places the child on the first sat of the commit input, i.e. at offset = parent value, and the policy
requires output 0 to carry exactly the parent input's value. So `PARENT_VALUE_SATS` (and the collection
address) is baked into every stored half-signed reveal: a parent UTXO of any other value can never be spent by
them, and the mint cannot re-sign them (only the user's K_e can). Changing the value strands every order that
is `awaiting_payment`, `paid` or `queued` (and every late payment of an expired quote) into self-rescue.

**Re-lease (same address, same value)** — the parent moved to a new outpoint (lost location, repeated
`missingorspent` on input 0, an out-of-band ord send):

1. Announce a short maintenance; stop new orders (`CORS_ORIGINS=` or take the API out of the load balancer).
2. Drain the lease: wait until no order is `revealing` (`GET /v1/queue` in flight = revealed-unconfirmed only).
3. Locate the parent: ord `/inscription/<PARENT_INSCRIPTION_ID>` gives its output; esplora `GET /tx/<txid>` must
   show that output paying `COLLECTION_ADDRESS` with exactly `PARENT_VALUE_SATS`. If the value differs, fix it on
   chain (an ord send of the parent to `COLLECTION_ADDRESS` with postage exactly `PARENT_VALUE_SATS`, signed out
   of band as in section 2 step 3) instead of changing `PARENT_VALUE_SATS`.
4. Stop the service (the one-off below must not race the worker).
5. Re-lease with the same environment as the service:
   `pnpm --filter @bsh/degent-mint exec tsx src/reinit-parent.ts <txid>:<vout>`. It checks the output on chain
   (collection script, value == `PARENT_VALUE_SATS`), refuses while an order is revealing or holds the lease, and
   logs `parent.lease.changed` with `old`/`new` outpoint and value.
6. Verify: no `parent.value.changed` in the logs; `GET /v1/health` `parent` ok and no `parentValue` check;
   `GET /v1/config` `parentValueSats` unchanged.
7. Start the service, restore traffic, and check the first reveal spends the new outpoint and pays output 0 to
   `COLLECTION_ADDRESS` with `PARENT_VALUE_SATS`. Awaiting reveals are unaffected.

**Alerting.** Every parent location change (initialise, re-lease, each reveal advancing it) logs
`parent.lease.changed` (`reason`, `old`, `new`). A change of the parent **value** additionally logs
`parent.value.changed` at error level and opens a persisted circuit breaker: the worker stops co-signing
(nothing is broadcast), health shows `parentValue` false, and it stays open across restarts until an operator
acknowledges.

**If the value changed by mistake:** re-lease to a parent with `PARENT_VALUE_SATS` (steps 3-5), then acknowledge,
naming the parent you verified (admin key with scope `mint:admin`, hash in `MINT_ADMIN_API_KEYS_JSON`):

```bash
curl -sS -X POST https://mint.degent.club/v1/admin/parent/ack \
  -H "Authorization: Bearer $MINT_ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"outpoint":"<txid>:<vout>","valueSats":10000,"note":"CHG-123 corrected re-init"}'
```

409 means the parent is not what you named (`details.current` shows what is there): re-check, do not guess.
Acknowledging never makes the worker spend a parent whose value differs from `PARENT_VALUE_SATS`: that check
stays, so acknowledging a wrong value only turns the error into the older `parent UTXO value differs` pause.

**If the value must change (rare; treat as a rotation):** drain completely (section 2 steps 1-2), announce, and
wait until no order is `approved`, `awaiting_payment`, `paid` or `queued`; orders paid late within
`LATE_PAYMENT_WINDOW_SECONDS` will still land in self-rescue, so announce that too. Then deploy the new
`PARENT_VALUE_SATS`, re-lease to the new-value parent, verify, and acknowledge the breaker. Every reveal signed
for the old value goes to rescue; users self-rescue with their bundle (section 5).

## 9. Event bus (RabbitMQ)

`AMQP_URL` (secret `services/degent-mint/amqp-url`) bridges every event onto the platform bus through
`@bsh/events` `connectAmqpBus` (exchange `AMQP_EXCHANGE`, default `bsh.events`; confirm channel; persistent
CloudEvents, `message-id` = domain `eventId`, so consumers de-duplicate). Mainnet refuses to start without it
(block.space and the studio learn about mints from these events); signet/testnet start with a warning and keep
events in-process.

| Situation | Behaviour | Action |
|---|---|---|
| Broker unreachable at startup | `startup refused … event bus unreachable (amqp://user:***@…)` within `AMQP_CONNECT_TIMEOUT_MS`; exit 1 | Fix the broker/credentials; the supervisor retries. |
| Connection or channel closed while running | `bus.lost` error, graceful shutdown (current tick finishes, backlog flushed if possible, store closed), exit 1 | Let the supervisor restart (`Restart=always`); startup waits for the broker. Orders do not advance while the mint is down; rescue timeouts protect users. |
| Publish nacked or unconfirmed (5 s) | `event.publish.failed`; the transition is NOT broken; the event waits in an ordered in-memory backlog retried every 15 s and before the next event; health `bus` false with the pending count | Check the broker (disk/memory alarms, flow control). |
| `event.publish.lost` | the backlog overflowed (10,000) or the process stopped with events unpublished; each is logged with `eventId` and `type` | Replay from the order timeline: `eventId` = `<orderId>:<timeline index>` (royalty: `<orderId>:royalty`, minted: `<orderId>:minted`). A replay tool / durable outbox is a follow-up. |
