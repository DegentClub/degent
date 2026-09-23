# Security

## What is at stake

The app never holds keys or funds. The worst realistic outcomes are:

1. A user pays the wrong amount, twice, or to the wrong address.
2. The Skrybit API key leaks or is abused through our proxy.
3. A user is tricked into inscribing to an address they do not control.

## Threat model and mitigations

| Threat                                              | Mitigation                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double payment (button re-enabled after success)    | `mint-machine`: `submitted` is terminal; `PAY_STARTED` refused unless `canMint`; `payingRef` guards the render gap. Tracker replaces the form.    |
| Paying a stale quote (fee edited during debounce)   | Quotes keyed by `{feeRate, fileHash, recipient}`; `canMint` requires an exact match. Late responses are dropped by request id.                   |
| Wrong network                                       | Adapters report the network; anything but mainnet is rejected at connect time with a clear message.                                               |
| Non-taproot / invalid recipient                     | `lib/address.ts` decodes bech32m/bech32/base58check with checksums; bc1p required client-side and again in the proxy.                             |
| Upstream returns a bogus payment address            | Proxy validates `payment_address` is a mainnet address and the amount is a positive integer before returning.                                     |
| API key exposure                                    | Key read only in the server route from `SKRYBIT_API_KEY`. The legacy `NEXT_PUBLIC_AUTH_TOKEN` still works but logs a deprecation warning.       |
| Open proxy abuse                                    | Per-IP 10 req/min and per-recipient 5 req/min sliding windows; `image/*` only; hard 4 MB cap plus the 200–400 KB collection rule; fee range check. |
| Information leakage via errors                      | Upstream error bodies are logged server-side only; clients get a generic message plus a `requestId` to quote.                                     |
| Excessive fee                                       | `FEE_MAX` 500 sat/vB hard cap; above `FEE_WARN` 50 the user must confirm in-page.                                                                  |
| Container compromise                                | Multi-stage image, non-root user, standalone output only, no dev deps at runtime.                                                                  |

## What the rate limiter does and does not do

`lib/rate-limit.ts` is an in-process sliding window keyed by client IP
(`x-forwarded-for` first hop, then `x-real-ip`) and by recipient address.

It does:

- cap quote requests per client and per recipient inside one Node process;
- expire hits individually (a burst does not unlock all at once);
- sweep stale keys so memory stays bounded.

It does not:

- share state between replicas. With N instances behind a load balancer the
  effective limit is N× the configured one. Move the store to Redis (or a
  similar shared store) before scaling horizontally;
- survive a restart;
- defend against a large botnet with many IPs. Use an edge WAF for that;
- verify that `x-forwarded-for` is trustworthy. Only deploy behind a proxy
  that overwrites it (the bundled nginx-proxy does).

## Operational notes

- Set `SKRYBIT_API_KEY` as a secret in the deployment environment; never bake
  it into the image.
- The `/api/health` endpoint reveals only whether a key is configured, not
  its value.
- Keep `FEE_MIN`, `FEE_MAX`, `FEE_WARN` and the size rules in `lib/fees.ts`
  and `lib/api.ts`; both client and server import the same constants.

## Reporting

Open a private issue or contact the Degent Club maintainers at
https://degent.club before disclosing publicly.
