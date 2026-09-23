# block.space: measure

**block.space** is the measurement product: it tells anyone what Bitcoin block space is doing, what it costs, and
what a given inscription or collection is actually worth and made of. It is the neutral reference the other two
products point at (degent.club collection membership is verified by the parent link that block.space displays).

## Vision

- **See** every block's space: who used it, for what (payments, inscriptions, runes, non-standard), at what fee.
- **Price** block space now and next: a fee Meter that predicts inclusion from real mempool and pool policy,
  including non-standard lanes (Libre Relay, Slipstream).
- **Own** a view of your holdings: a portfolio of inscriptions and sats with provenance and cost basis.
- **Build on it**: the same data through a public, versioned API.
- **Trust it**: certification of collections and inscriptions (parent/child provenance, content hash checks).

## Components

| Component | Package | Kind | Path | What it is |
|---|---|---|---|---|
| `blockspace-meter-client` | `@bsh/meter-client` | library | `packages/meter-client` | Typed, zero-dependency client for the live Meter API at https://block.space (retries, timeouts, abort, contract-drift guards) |
| `blockspace-certify` | `@bsh/blockspace-certify` | service | `services/certify` | "Verified by block.space" collection certification: parent/child + inscribed-manifest membership, reproducible stats, BIP340-signed attestations. Provides `contracts/openapi/blockspace-collections.yaml`. First customer: degent.club |

Query `catalog/catalog.json` for the live dependency and contract graph.

### Planned

Names are provisional; each lands with a `component.yaml`, a contract in `contracts/` where it serves other
products, and an ADR for anything architectural:

| Component | Kind | Path | Notes |
|---|---|---|---|
| `blockspace-explorer` | app | `apps/explorer` | Block, transaction and inscription explorer |
| `blockspace-meter` | service + app | `services/meter`, `apps/meter` | Fee and inclusion predictions; reuses `@bsh/inscription` weight maths |
| `blockspace-portfolio` | app | `apps/portfolio` | Holdings, provenance, cost basis; uses `@bsh/wallet-kit` |
| `blockspace-data-api` | service | `services/data-api` | Public API; provides `contracts/openapi/blockspace-data.yaml` |

Indexers and chain data pipelines live in the separate `data` and `chain` repositories (ADR-0001); this product
consumes them through contracts and `events:` channels.
