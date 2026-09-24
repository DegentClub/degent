# flashy/ - degent.club's FlashyOS accountability files

The FlashyOS **AAO 0.1** well-known files degent.club publishes, in the formats implemented by the platform's
[`@bsh/mesh`](../deps/scribbit/platform/mesh/README.md) (platform ADR-0010, `deps/scribbit/docs/adr/`). Three
files are hand-written sources; everything else is **generated and committed**, and CI fails when the two disagree.

Degent Club is a members' club: the Club is a place, membership is earned by making, and the house keeps the rules
and the seal. The charter says who answers for that, which standing roles run it, and which of them a person must
approve before they act.

## Files

| File | Role | Format |
|---|---|---|
| `charter.json` | SOURCE. Who degent.club is, who answers for it, its roles (`parent-custody`, `mint-operation`, `art-review`, `pricing`, `artist-relations`) and what each may do; `x-bitcoin` carries the Bitcoin extension (network, signing, collection and royalty model) | `aao/0.1` charter |
| `frontdoor.config.json` | SOURCE. The lanes a stranger may open (`integrate`, `partnership`, `machine`, `general`) and the four rungs; rung 3 is "your agent minted a Degent, or your artists hang in the Studio" | input to `frontdoor/1` |
| `directory.config.json` | SOURCE. Provenance (`asserted`, `expires`, `assertedBy`), platform/vertical and the `degent.club` property | input to `directory/0.1` |
| `directory.externals.json` | GENERATED. Ids the fragment references that another repository defines | externals list |
| `public/flashyos.roles.json` | GENERATED = `charter.json` | `aao/0.1` |
| `public/.well-known/flashyos-charter.json` | GENERATED = `charter.json` (same bytes) | `aao/0.1` |
| `public/.well-known/frontdoor.json` | GENERATED from `frontdoor.config.json`; carries FlashyOS's `NOT_AUTHORITY` paragraph verbatim | `frontdoor/1` |
| `public/directory.fragment.json` | GENERATED from `charter.json` + `directory.config.json` | `directory/0.1` |

## Serving

`public/` must be mounted at the **degent.club site root** (the web app's static root, `products/degent/apps/web`,
or the fleet edge in front of it) so these URLs resolve:

| Path on degent.club | File |
|---|---|
| `https://degent.club/flashyos.roles.json` | `public/flashyos.roles.json` |
| `https://degent.club/.well-known/flashyos-charter.json` | `public/.well-known/flashyos-charter.json` |
| `https://degent.club/.well-known/frontdoor.json` | `public/.well-known/frontdoor.json` |
| `https://degent.club/directory.fragment.json` | `public/directory.fragment.json` |

Until they are served, the front door's `endpoint` (`https://degent.club/frontdoor`) and `ladder`
(`https://degent.club/engage/`) are promises with nothing behind them.

## Placeholders

Two values validate but **must be replaced by a real, named human before anything is published**:

- `accountableTo: "accountable@degent.club"` in `charter.json`: aao 0.1 asks for a reachable person, not an alias.
- `assertedBy: "person/bsh-accountable"` in `directory.config.json`: referenced, listed in the externals, defined
  nowhere yet.

## Regenerating

```bash
pnpm mesh:emit     # rewrite everything generated from the three sources
pnpm mesh:check    # validate every file (what CI runs after the diff gate)
```

Re-run `pnpm mesh:emit` after every platform pin bump: the rules come from `deps/scribbit/platform/mesh`.
