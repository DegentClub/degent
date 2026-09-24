# Architecture decision records

ADRs are numbered globally across the three DegentClub repositories (ADR-0004 in DegentClub/scribbit). The
platform's records — [0001 monorepo structure](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0001-monorepo-structure.md),
[0003 machine-readable catalog](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0003-machine-readable-catalog.md),
[0004 repo split](https://github.com/DegentClub/scribbit/blob/claude/wizardly-hypatia-5l6s56/docs/adr/0004-repo-split.md) —
are readable locally at `deps/scribbit/docs/adr/` at the pinned commit. A product-specific decision lives here;
start from `deps/scribbit/docs/adr/template.md` and take the next free number.

| ADR | Title | Status |
|---|---|---|
| [0002](0002-degent-mint-architecture.md) | degent.club automated mint: non-custodial, parent-linked, block-sized | Accepted, partially superseded by 0005 |
| [0005](0005-sighash-all-anyonecanpay-reveals.md) | SIGHASH_ALL\|ANYONECANPAY reveals; self-rescue by re-signing with K_e | Accepted |
| [0007](0007-member-approval-and-register.md) | Member approval gates the parent link; the Register is the club's roll | Accepted |
