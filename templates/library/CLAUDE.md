# @bsh/__component__ - agent notes

Read the root `CLAUDE.md` first. Local rules:

- Kind: **library**. Manifest: `component.yaml` (the catalog entry in `catalog/catalog.json` is generated from it).
- Import only packages listed in `depends_on`; `pnpm lint:boundaries` fails otherwise.
- Keep the public API in `src/index.ts`; everything else is private.
- Verify with `pnpm --filter @bsh/__component__ test` and `typecheck` before finishing.
