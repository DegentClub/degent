# blockspace-certify runbook

Service: `@bsh/blockspace-certify` · owner `team-blockspace` · SLO 99.9 % / p95 200 ms (reads) ·
contract `contracts/openapi/blockspace-collections.yaml`.

## Dependencies

| Dependency | Why | If it fails |
|---|---|---|
| ord server (`CERTIFY_ORD_URL`, JSON API) | all membership, sizes, block height | reads keep serving the last attestation; `/v1/health` → `degraded`; refresh → 502 |
| secret `services/blockspace-certify/attestation-key` | signs attestations (`CERTIFY_SIGNING_KEY`) | process refuses to start (exit 2) |
| secret `services/blockspace-certify/admin-token` | protects refresh (`CERTIFY_ADMIN_TOKEN`) | process refuses to start (exit 2) |
| `CERTIFY_COLLECTIONS_FILE` | which collections exist, their parent / manifest | exit 2 with every problem listed |

## Routine operations

**Deploy / restart.** Snapshots are in memory: after every start, refresh each collection.

```bash
curl -fsS -X POST -H "authorization: Bearer $CERTIFY_ADMIN_TOKEN" https://<host>/v1/collections/degent/refresh | jq .attestation.stats
```

Refresh is synchronous. Budget ≈ 2 ord requests per member (record + reveal tx) plus one content fetch per manifest
item that declares a `sha256`; for degent (~4.1k) at `CERTIFY_CONCURRENCY=8` against a local ord expect well under
a minute. Give the proxy route a ≥ 5 min timeout.

**Scheduled refresh.** Run the same call after new mints (e.g. every 30 min, or on `degent.mint.*` delivered
events). A 409 `refresh_in_progress` means one is already running: do not retry in a loop.

**Check a published attestation** (what customers and auditors do):

```bash
curl -s https://<host>/v1/keys
curl -s https://<host>/v1/collections/degent > att.json
# in any TS runtime with the package: verifyAttestation(att.attestation, publicKeyHex) → { ok: true }
```

## Onboarding degent.club's legacy manifest

1. `pnpm --filter @bsh/blockspace-certify manifest:from-collection-json <collection.json> --compact > degent-manifest.json`
   (exit 1 lists every bad or duplicate entry; fix the source file, never hand-edit the output).
2. Review the item count (4,112) and the printed `manifestSha256` with the collection owner.
3. The collection owner inscribes the file **as a child of the degent parent** (content type `application/json`).
4. Set `manifest.inscriptionId` (and `parentInscriptionId`) in the collections file; redeploy; refresh.
   The manifest source must show `verified: true` and `manifestSha256` equal to step 2.

Until step 4, the manifest source shows `verified: false` and legacy items are not counted. That is correct.

## Alerts and diagnosis

| Symptom | Likely cause | Action |
|---|---|---|
| refresh 502 `upstream_error` | ord down, slow, or an ord upgrade changed JSON shapes | `curl -H 'accept: application/json' $CERTIFY_ORD_URL/inscription/<id>`; shape drift is deliberate fail-loud, update `adapters/http-ord.ts` + tests |
| refresh 422 `parent_not_found` / `manifest_not_found` | ord not synced past the inscription, or a typo in config | compare `/r/blockheight` with the inscription height; fix config |
| refresh 422 `manifest_invalid` | inscribed manifest does not parse, is for another slug, or differs from the configured file | re-run step 1 and compare `manifestSha256` |
| large `excludedCount` with `parent_link_missing` | ord's children index lists ids whose records lack the link (reindex in progress / bug) | expected to be excluded; confirm on a second ord before escalating |
| `totalRevealVbytes: null` | ord `/tx/<txid>` unavailable for at least one reveal | stats stay valid; investigate ord `/tx` |
| health `degraded` | ord unreachable | reads still served; fix ord |
| many 429 `rate_limited` from one address | behind a proxy every client shares the proxy's IP | limits are per TCP peer (`@bsh/edge` ignores `X-Forwarded-For` unless `trustProxy` is wired, which this service does not do yet); raise limits via `createApp({ rateLimits })` or add `trustProxy({ trusted })` for our own proxy CIDRs |

## Key rotation

1. Generate a new key into `services/blockspace-certify/attestation-key` (keep the old public key).
2. Deploy, refresh every collection (new `keyId`).
3. Publish the old public key as `retired` (the `/v1/keys` array already supports several keys; the adapter
   for serving retired keys is a follow-up) so previously issued attestations remain verifiable.

A leaked key lets someone forge attestations but move no funds: rotate immediately and announce the old `keyId`
as compromised.
