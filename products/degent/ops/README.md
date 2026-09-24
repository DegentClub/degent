# degent-mint observability (as files)

Grafana dashboard and Loki alert rules for `@bsh/degent-mint`, built **only** from the JSON lines the service writes
to stdout (`src/application/logger.ts`: `{time, level, service, msg, …fields}`). No metrics endpoint is needed.

| File | What |
|---|---|
| `grafana/degent-mint.dashboard.json` | Dashboard (uid `degent-mint`); variables `loki` (datasource) and `job` (stream label, default `degent-mint`) |
| `alerts/degent-mint.rules.yaml` | Loki ruler rule groups (Prometheus format, LogQL `expr`), each with a `runbook_url` into `services/mint/RUNBOOK.md` |

`test/ops.test.ts` (repository root, `pnpm test:root`) parses both files and fails when a `msg` or field they use no
longer appears in the service code, or when a runbook anchor does not exist in RUNBOOK.md.

**Shipping.** The log shipper (Alloy/Promtail) must put degent-mint's stdout in a stream labelled `job="degent-mint"`;
change the dashboard's `job` variable and the rules' selector if your label differs. Queries parse with `| json`, so
every JSON field becomes a label: aggregations always group explicitly (`by (…)`), never over raw lines.

## Log lines used

| `msg` | Emitted by | Fields used |
|---|---|---|
| `order transition` | `OrderService.transition` (every transition, API and worker) | `orderId`, `from`, `to`, `lane`, `tier`, `msInPreviousStatus` (ms spent in `from`), `payToDeliveredMs` (only on `delivered`), `txid`, `detail` |
| `art review verdict` | `OrderService.uploadContent` (every review) | `reviewer`, `approved`, `reasonCount`, `square`, `pepeInTuxWithBowtie`, `framedWithPlacard`, `placardText`, `advisoryFails` |
| `mint gauges` | `MintWorker.run`, at most once a minute | `memberReview`, `memberReviewOldestAgeSeconds`, `rescueAvailable`, `queued`, `revealing`, `awaitingConfirmation`, `parentKnown`, `parentConfirmed`, `parentLeased` (0/1) |
| `broadcast failed` | worker, lane broadcaster error | `orderId`, `lane`, `via`, `error`, `retryable` |
| `no parent UTXO configured; cannot reveal` | worker dispatch | — |
| `policy signer refused` | in-memory policy signer | `orderId`, `violations` |
| `worker step failed`, `tick failed` | worker | `orderId`, `step`, `error` |

## Panels

| Panel | Query basis | Read it as |
|---|---|---|
| Orders by status over time | `order transition` count by `to` | Flow into each status per interval (stacked bars). A status that stops receiving orders shows where the pipeline stalls. |
| Time in status p50 / p95 | `unwrap msInPreviousStatus` by `from` | How long orders sat in a status before leaving it. `member_review` is days by design; `queued`/`revealing` should be minutes. |
| Pay → delivered latency | `unwrap payToDeliveredMs` on `to="delivered"`, by lane | End-to-end time the collector waits after paying, including the member vote. |
| member_review backlog | gauge `memberReview` | Orders waiting for the members. |
| Oldest member_review | gauge `memberReviewOldestAgeSeconds` | Age of the oldest; at `REVIEW_SLA_SECONDS` (14 d default) it goes to self-rescue. |
| rescue_available | gauge `rescueAvailable` + transitions `to="rescue_available"` | Orders the service will not link to the parent; users self-rescue. |
| Lane broadcast failures | `broadcast failed` by `lane`, `via`, `retryable` | Retryable = same tx rebroadcast every tick; permanent = order requeued. |
| Parent health | gauges `parentKnown`, `parentConfirmed`, `parentLeased` + no-parent errors | 1/1/0 is the normal idle state; `known` 0 pauses every reveal. |
| Art review verdicts | `art review verdict` by `approved` | Hard verdicts (file rules + safety categories only). |
| Advisory rule fails | `art review verdict` with `square` / `pepeInTuxWithBowtie` / `framedWithPlacard` = `fail`, `advisoryFails > 0` | How often uploads miss the site's Minting Rules. Never a rejection. |
| Worker and signer errors | `worker step failed` by `step`, `policy signer refused`, `tick failed` | Anything here deserves a look; a policy refusal always does. |

## Alerts

| Alert | Condition (default) | Severity | Runbook |
|---|---|---|---|
| `DegentMintParentMissing` | gauge `parentKnown` < 1 over 10 m, or any no-parent error | critical | RUNBOOK §6 |
| `DegentMintParentLeaseStuck` | `parentLeased` = 1 for 30 m | warning | RUNBOOK §6 |
| `DegentMintBroadcastFailing` | > 3 `broadcast failed` per lane/backend in 15 m | warning | RUNBOOK §4 |
| `DegentMintBroadcastRejected` | any permanent (`retryable="false"`) rejection in 15 m | critical | RUNBOOK §4 |
| `DegentMintPolicySignerRefused` | any `policy signer refused` in 15 m | critical | RUNBOOK §5 |
| `DegentMintQueuedTooLong` | p95 time in `queued` > 2 h per lane (1 h window) | warning | RUNBOOK §1 |
| `DegentMintRevealingStuck` | gauge `revealing` > 0 for 30 m | warning | RUNBOOK §1 |
| `DegentMintRescueSurge` | > 2 transitions to `rescue_available` in 1 h | warning | RUNBOOK §5 |
| `DegentMintWorkerErrors` | > 5 `worker step failed` per step in 15 m | warning | RUNBOOK §1 |
| `DegentMintWorkerSilent` | no `mint gauges` line for 10 m | critical | RUNBOOK §8 |
| `DegentMintMemberReviewAging` | oldest `member_review` > 7 d (half the default SLA) | warning | RUNBOOK "Member review" |
| `DegentMintMemberReviewBacklog` | > 25 orders in `member_review` for 1 h | warning | RUNBOOK "Member review" |
| `DegentMintArtRejectRateHigh` | > 50 % of ≥ 10 reviews rejected in 1 h | warning | RUNBOOK §7 |

Thresholds are starting points for launch; revisit them after the signet rehearsal (docs/LAUNCH-CHAIN-SETUP.md).

## Load

- Dashboard: Grafana → Dashboards → Import → upload the JSON, pick the Loki datasource.
- Rules: copy the YAML into the Loki ruler's rule directory for the tenant (or sync it with your ruler tooling), with
  `runbook_url` rewritten to your repository host if needed (they are repository-relative).
