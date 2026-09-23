# @bsh/blockspace-certify

The **"Verified by block.space"** collection certification service. For each configured collection it resolves
membership from on-chain evidence, computes official statistics that anyone can reproduce with their own ord, and
publishes them as a **BIP340-signed attestation**. degent.club is the first customer.

It does not index the chain (it reads an ord server), does not hold any key that moves funds (its key signs
attestation digests only), and does not decide membership by hand: a collection's own parent inscription does.

API: [`contracts/openapi/blockspace-collections.yaml`](../../../../contracts/openapi/blockspace-collections.yaml)
(tests validate every response against it). Operations: [RUNBOOK.md](./RUNBOOK.md). Env: [env.schema.json](./env.schema.json).

```bash
pnpm --filter @bsh/blockspace-certify test | typecheck
CERTIFY_DEV=1 CERTIFY_ORD=fake CERTIFY_ADMIN_TOKEN=dev-admin-token-123456 \
  CERTIFY_COLLECTIONS_FILE=config/collections.example.json pnpm --filter @bsh/blockspace-certify dev
```

| Endpoint | |
|---|---|
| `GET /v1/health` | liveness + ord reachability |
| `GET /v1/keys` | x-only public key(s), `keyId`, hash tag |
| `GET /v1/collections/:slug` | latest attestation + digest + exclusions |
| `POST /v1/collections/:slug/refresh` | re-resolve and re-sign (Bearer admin token; synchronous; 409 if running) |
| `GET /v1/collections/:slug/items?cursor=&limit=` | members, keyset-paged in (number, id) order |

## Membership

1. **parent-children**: page through ord's children of the parent (`/r/children/<id>/<page>`), then fetch each
   child's record. Accepted only if the record itself names the parent; otherwise excluded with
   `parent_link_missing`. Anything revealed after `asOfBlockHeight` is excluded (`after_as_of_height`).
2. **manifest** (legacy items minted before parent links): `{ collection, items: [{ inscriptionId, sha256?, contentLength? }] }`.
   It counts only when **inscribed as a child of the collection parent** (`verified: true`); the parent link is the
   collection's signature. Each item must exist on ord and match any declared `contentLength` / `sha256`.
   An off-chain or non-child manifest is reported `verified: false` and its items are not counted
   (`allowUnverifiedManifest` overrides this for previews; the signed source still says `verified: false`).

An inscription accepted by either source is a member; exclusions are reported only for non-members.

### degent.club's 4,112 legacy items

`Degent-Marketplace/collection.json` is the only list today. Convert it, review it, inscribe it as a child of the
degent parent, then point the config at the inscription:

```bash
pnpm --filter @bsh/blockspace-certify manifest:from-collection-json /path/to/collection.json --compact > degent-manifest.json
```

`--compact` emits the canonical bytes to inscribe (`application/json`; 357,778 bytes for the current file, a
standard-relay reveal). `size_kb` is not carried over: it is rounded and its unit is ambiguous; sizes always come
from ord.

## Statistics and signature

`stats`: `itemCount`, `excludedCount`, `totalContentBytes` (ord `content_length`; null counts 0), min/max/median
item bytes (even count: mean of the two middle values), first/last inscription number, `totalRevealVbytes` /
`revealTxCount` over **distinct** reveal txids (batch reveals counted once, whole tx; null if any reveal cannot be
sized), and `itemsDigest` = sha256 of canonical `[[id, number, contentLength], …]`. Pure functions in
`src/domain/stats.ts`; property tests check order-invariance.

Signature: `BIP340(taggedHash("block.space/collection-attestation/v1", canonicalJson(attestation − signature)))`,
canonical JSON = RFC 8785 for our value domain. `verifyAttestation(attestation, publicKeyHex)` (exported) checks
it offline. Same chain + same clock ⇒ identical attestation and digest; the signature itself uses BIP340 aux
randomness.

## Layout

`domain/` (pure: canonical JSON, stats, manifest, attestation) · `ports/` (`OrdPort`, `AttestationSigner`,
`SnapshotStore`, `Clock`) · `adapters/` (`HttpOrd`, `FakeOrd`, `InMemoryAttestationSigner`,
`MemorySnapshotStore`) · `application/certify-service.ts` · `app.ts` (Hono + `@bsh/edge`) · `http/middleware.ts` · `cli/`.

**Edge middleware:** the platform `@bsh/edge` stack (request ids, uniform `{error:{code,message,requestId}}`
bodies, security headers, CORS `*` without credentials for public reads, per-IP token-bucket rate limits, 1 KiB
body limit on refresh). Only the operator bearer check for `refresh` is local (`src/http/middleware.ts`).

**Known limits:** snapshots are in memory (lost on restart; re-run refresh); refresh is synchronous (≈2 ord calls
per member at `CERTIFY_CONCURRENCY`); the signer adapter is in-memory (a KMS adapter implements the same port).
