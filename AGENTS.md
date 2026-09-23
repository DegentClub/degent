# AGENTS.md

Instructions for any coding agent (Claude, Codex, Cursor, Copilot, ...) working in this repository.

1. **Read [`CLAUDE.md`](./CLAUDE.md).** It is the canonical agent guide (map, rules, common tasks), not Claude-specific.
2. **Query [`catalog/catalog.json`](./catalog/catalog.json) before grepping.** It lists every component with its
   path, owner, dependencies, dependents, contracts, scripts and docs. Platform components carry
   `external: { repo, commit, root }` and live under `deps/scribbit` (a submodule pinned to that commit). Example:
   `jq '.components[] | select(.product=="degent") | {name, path, depends_on}' catalog/catalog.json`.
3. **Follow the rules.** Every package has a `component.yaml`; import only what `depends_on` declares; contracts
   first; no secrets in the repo; never edit `deps/scribbit` in place (fix it in DegentClub/scribbit, then bump
   the pin). Before finishing, run `pnpm check`, and `pnpm catalog` if you changed a manifest.
4. Then read the local `CLAUDE.md` / `README.md` of the component you are changing, and any ADR it links
   (`docs/adr/` here, `deps/scribbit/docs/adr/` for the platform).
