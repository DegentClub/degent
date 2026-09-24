# Signet rehearsal

Before mainnet, the whole mint is rehearsed on signet with real wallets, real members and real outages, and
the result is recorded as a machine-readable report. Deployment: [`DEPLOY.md`](./DEPLOY.md). Incidents:
[`RUNBOOK.md`](../products/degent/services/mint/RUNBOOK.md).

- **Runner**: [`scripts/rehearsal/run.mjs`](../scripts/rehearsal/run.mjs) (`pnpm rehearsal -- ...`). It talks
  only to the public API, never sees a key, PSBT or order token, never pays, and refuses to create orders on
  mainnet.
- **Scenarios**: [`scripts/rehearsal/scenarios.json`](../scripts/rehearsal/scenarios.json).
- **Report**: `rehearsal-report.json` (per scenario: `name`, `wallet`, `device`, `lane`, `orderId`, `result`
  `pass | fail | pending`, `reason`, `finalStatus`, `rescued`, `path`, and `timings` with `paidAt`,
  `confirmedAt`, `approvedAt`, `declinedAt`, `rescueOfferedAt`, `deliveredAt`, `payToConfirmSec`,
  `confirmToApproveSec`, `approveToDeliveredSec`, `payToDeliveredSec`).
- **Proof the runner works**: `test/rehearsal.test.ts` runs it against the mint's in-memory app (the service's
  own test harness) with the test playing wallet, members and miner.

## Which signet

| | Private fleet signet (btc-signet / ord-signet) | Public signet |
|---|---|---|
| Block lane | yes: we run the miner; `acceptnonstdtxn=1` on btc-signet, `LIBRE_RPC_URL` → its RPC | no public path for ~4 MB non-standard transactions |
| Coins | `fleet signet fund <addr> <sats>`, `fleet signet mine N` (fast blocks) | faucets, 10-minute blocks |
| Browser wallets | only if the wallet signs PSBTs for UTXOs its own backend cannot see (the app fetches UTXOs from `VITE_ESPLORA_URL`) | supported by the listed wallets |
| esplora / ord | needs a fleet signet esplora (DEPLOY.md, prerequisite 1); ord-signet exists | mempool.space/signet, a signet ord |

Run the service-side scenarios (smoke, policy refusal, approve, decline/SLA rescue, block lane, lane outage)
on the **private signet**. Run the wallet matrix there first; any wallet that refuses (it cannot see the
inputs) is re-run on a public-signet deployment of the same images (same compose file, other `.env`) and noted
in the report's `reason`. Record which chain each report came from (`network` is `signet` in both: keep one
report file per deployment).

## Preparation (owner + operator)

1. Deploy: `compose.signet.yaml` ([DEPLOY.md](./DEPLOY.md#containers)) or the fleet hosts
   ([handoff](./DEPLOY.md#fleet-wiring-handoff-proposal-for-scribbittinfrastructure)). Signet settings that make
   drills fit in a day: `REVIEW_SLA_SECONDS=3600`, `RESCUE_AFTER_SECONDS=3600`, `CONFIRMATIONS=1`.
2. Parent: inscribe a signet parent to the signet parent key's taproot address; set `PARENT_INSCRIPTION_ID`,
   `PARENT_OUTPOINT`, `COLLECTION_ADDRESS`; put the key in `secrets/parent-key`.
3. Members: inscribe at least five test "Gallery" Degents on signet to five member wallets, build a signet
   roster (`node products/degent/services/mint/scripts/build-roster.mjs ...`) and mount it (`ROSTER_PATH`).
   Without it nobody is a member on signet and no vote can pass.
4. Wallets: UniSat, Xverse, Leather, OKX Wallet, Magic Eden, each on desktop (extension) and mobile, switched to
   signet/testnet mode and funded.
5. Smoke: `node scripts/rehearsal/run.mjs --base-url https://signet.degent.club/api --auto` must be all `pass`
   (health `ok` means store, chain and parent are fine).

## Running it

```bash
# 1. automated checks (repeat after every deploy)
node scripts/rehearsal/run.mjs --base-url https://signet.degent.club/api --auto --out rehearsal-report.json

# 2. humans run the manual scenarios in the web app and note each order id (Track page) in orders.json:
#    { "wallet-unisat-desktop": "dgt_...", "approve": "dgt_...", "decline-rescue": "dgt_...", ... }

# 3. snapshot progress at any time (pending = still running), or wait for completion
node scripts/rehearsal/run.mjs --base-url https://signet.degent.club/api --orders orders.json
node scripts/rehearsal/run.mjs --base-url https://signet.degent.club/api --orders orders.json --wait --poll-ms 30000
```

Exit code 1 when any scenario failed; pending scenarios do not fail the run. Attach the final
`rehearsal-report.json` to the launch ticket.

## Scenarios

| Scenario | Mode | Operator does | Passes when |
|---|---|---|---|
| `smoke` | auto | nothing | health `ok`, config on the right network, fees, queue |
| `intake-standard` / `intake-block` | auto | nothing | a fixture PNG order is created, uploaded, reviewed `approved` with a binding quote on the expected lane (never paid) |
| `policy-refusal` | auto | nothing | wrong-network recipient, fee below minimum, disallowed type, size outside tiers, invalid reveal key are refused with 422 `validation_failed`; an image below the minimum dimensions is `rejected` by the art review |
| `wallet-<wallet>-<desktop\|mobile>` (10) | manual | full Standard mint with that wallet: connect, create, pay, keep the recovery bundle; members approve | `delivered`, not rescued, standard lane, path through `paid`, `member_review`, `queued`, `revealed`, `confirmed`, `verified` |
| `approve` | manual | three members sign in on `/review` and approve | `delivered` via `member_review` → `queued` (Degent number 4112 + rank) |
| `decline-rescue` | manual | three members decline; the user uses "Rescue now" (bundle + passphrase) | `delivered` with `rescued: true`, path through `declined` |
| `sla-rescue` | manual | nobody votes; after `REVIEW_SLA_SECONDS` the user rescues | `delivered` with `rescued: true`, path through `rescue_available` |
| `block-lane` | manual | a Block Degent (> 390 KB), members approve | `delivered` on the block lane; logs show `via: libre-relay`; one block-lane reveal in flight at a time |
| `lane-outage` | manual | stop the block-lane RPC (or point `LIBRE_RPC_URL` at a closed port and restart `mint-worker`), mint + approve a Block Degent, watch retryable `broadcast failed`, restore within `RESCUE_AFTER_SECONDS` | `delivered` on the block lane after the backend returns (the same txid is rebroadcast) |

Also check by hand during the rehearsal (not scripted): the alert queries in
[DEPLOY.md](./DEPLOY.md#observability) fire for the outage and backlog drills; a backup restore drill
([DEPLOY.md](./DEPLOY.md#backups)) on the rehearsal data; the Track page shows "hash match" for delivered orders;
the Register lists approved children.

## Exit criteria for the mainnet soft launch

- Every scenario `pass` in one report per deployment (wallet exceptions documented in `reason`).
- `payToConfirmSec` / `approveToDeliveredSec` for standard orders within one or two blocks of the chain's
  block interval; no scenario needed manual database work.
- Restore drill done with the rehearsal data; alerts observed during the outage drill.
- The KMS policy signer exists and passed its own review (mainnet refuses to start without it).
