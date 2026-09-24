# degent-atelier runbook

Service: `@bsh/degent-atelier`. It spends money: every generation calls a paid image provider. It never
touches bitcoin or keys that move funds. Its output bytes are later inscribed permanently, so never hand-edit
content blobs.

Useful reads: `GET /v1/health` (provider mode, queue depth, `spentTodayCents` vs `dailyCostCapCents`),
`GET /v1/config`. Logs are JSON lines (`service: "degent-atelier"`). Key messages: `job queued`
(`jobId, sessionId, tier, variations, costCents`), `job done`, `job failed` (`internal` = scrubbed provider
detail), `candidate finalised` / `upload finalised` (`sha256, bytes, quality, canvas, grain, attempts`).

## 1. Health says `provider.mode: "fake"` in production

No provider key reached the process. Check the secret paths `services/degent-atelier/openai-api-key` (or
`http-provider-api-key`) and `ATELIER_MODE`. Fake mode is a valid demo configuration, but it produces placeholder
art that must not be minted. Once a key is present, the service refuses to start without `DATABASE_PATH` and `CONTENT_DIR`.

## 2. `cost_cap_reached` / health `degraded` (budget)

1. Health `checks[budget]` shows spend vs cap. Spend is the sum of `reserved` + `settled` ledger rows since 00:00 UTC.
2. Look for abuse: top sessions by images today.
   ```sql
   SELECT session_id, SUM(images) n, SUM(cost_cents) c FROM ledger
    WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now') AND status != 'failed'
    GROUP BY session_id ORDER BY c DESC LIMIT 20;
   SELECT ip, COUNT(*) FROM sessions WHERE created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now') GROUP BY ip ORDER BY 2 DESC LIMIT 20;
   ```
   Tighten `SESSIONS_PER_IP_PER_DAY`, `SESSION_DAILY_IMAGES` or `RATE_LIMIT_PER_MINUTE`, and redeploy.
3. Raising the cap is a product decision: change `GLOBAL_DAILY_COST_CENTS` and redeploy. Do not edit ledger rows to free budget.
4. After a crash, jobs that were in flight leave `reserved` rows that still count until midnight. That is expected and
   conservative. Do not flip them by hand.

## 3. Jobs failing (`job failed`, users see `provider_unavailable`)

Read `internal` in the log line (scrubbed; never paste raw provider responses into tickets).

| `internal` shows | Meaning / action |
|---|---|
| `HTTP 401` | Key revoked or rotated: fix the secret (section 5). |
| `HTTP 429` | Provider rate limit: lower `WORKER_CONCURRENCY`; jobs are not auto-retried and users can resubmit (their quota was refunded). |
| `HTTP 5xx` / `unreachable` | Provider outage: check its status page. Consider `ATELIER_MODE=http` with a secondary provider. |
| `model_not_found` then success | `gpt-image-1` is unavailable to the org and we fell back to `dall-e-3`. Verify the OpenAI org to restore the primary. |
| `declined this brief` | Content policy refusal (user-facing message is already safe). Nothing to do unless it's widespread. If so, check the scaffold (`src/prompt.ts`) changes. |

## 4. `range_unreachable` on finalize or upload

The compositor could not land inside the tier's byte window. Common causes:
- **Full Block from flat art**: needs grain; very flat or dark art can fail even at maximum grain. Suggest Large.
- **Pure black / near-uniform uploads with `frame=false`**: overlay grain cannot add entropy to black. Suggest `frame=true`.
- Log `attempts` shows the search effort. Never widen tier bounds here: they mirror the mint contract, and
  `test/contract.test.ts` asserts they agree with `degent-mint.yaml`.

## 5. Rotating provider keys

1. Create the new key at the provider. Write it to `services/degent-atelier/openai-api-key` (or the HTTP / vision path).
2. Redeploy. Keys are read at boot only.
3. Check `/v1/health` (`provider.mode: "live"`), run one generation with a test session, then revoke the old key.
   If a key was ever exposed in a log, treat it as leaked. The code scrubs `sk-…` and `Bearer …`, but third-party wrappers might not.

## 6. Disk usage in `CONTENT_DIR`

Blobs are content-addressed (`<dir>/<aa>/<sha256>`) and never deleted by the service. Finalised JPEGs must stay
until minted, because the mint front end fetches them by hash. Provider sources and previews can be pruned once they are
older than the session TTL (default 24 h):
```bash
# dry run first; only prune what no finalised download might still need (keep >= 7 days to be safe)
find "$CONTENT_DIR" -type f -mtime +7 -print | head
```
A proper GC (reference-tracked) is future work.

## 7. Memory / CPU

Full Block finalisation renders up to 4096x4096 canvases (~50 MB raw each, at most 3 cached per call) and can take
~5-10 s of CPU. Sustained Full Block traffic: lower `WORKER_CONCURRENCY` / `SESSION_RATE_LIMIT_PER_MINUTE` or scale
vertically. The upload decoder refuses images over 8192x8192 pixels (decompression-bomb guard) and bodies over 8 MiB.
