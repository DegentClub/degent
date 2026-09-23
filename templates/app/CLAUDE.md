# @bsh/__component__ - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **app**. Manifest: `component.yaml` (the catalog entry in `catalog/catalog.json` is generated from it).
- Import only packages listed in `depends_on`; `pnpm lint:boundaries` fails otherwise.
- Talk to other products only through `contracts/`; change the contract first.
- Verify with `pnpm --filter @bsh/__component__ test` and `typecheck` before finishing.
