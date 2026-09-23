## Summary

<!-- What changes and why, in two or three sentences. Link the ticket. -->

## Component(s)

<!-- Names from catalog/catalog.json, e.g. `degent-mint`, `inscription`. Query: jq '.components[].name' catalog/catalog.json -->

-

## Contract changes

<!-- contracts/ is the only coupling between products. Contract first, then code. -->

- [ ] No contract changes
- [ ] Contract changed (path + summary below); `oasdiff breaking` reports no breaking change, **or** this is a new major version with a migration note

## Tests

<!-- What proves this works? New behaviour ships with tests; fee/size maths ships with property-style tests. -->

- [ ] `pnpm check` passes locally (validate + boundaries + typecheck + test)
- [ ] `pnpm catalog` re-run and committed if any component.yaml changed

## ADR

<!-- Link the ADR for any architectural decision (new component, data flow, security, signing). "n/a" otherwise. -->

- ADR:
