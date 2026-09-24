# @bsh/degent-x-bot - agent notes

Read the root `CLAUDE.md` and `products/degent/CLAUDE.md` first, then this package's `README.md` and `brain/BRAIN.md`
(the account's voice and the CONTENT APPROVAL TIERS). Local rules:

- Kind: **service** (a content engine, not the legacy bot). Manifest: `component.yaml`; the catalog entry is generated.
- **Every outbound text goes through `gateContent`** (`src/content/safety.ts`). Nothing posts unless the tier is
  `auto` AND `REVIEW_QUEUE_ENABLED=false` AND the safety checks pass (and `POSTING_ENABLED=true`). Never add a path
  to `XClient.post` that bypasses `Publisher`.
- **The classifier is deterministic on purpose** (regex rules, table-driven tests). Loosening a rule needs a test row
  that shows why; manual tier is never unlocked by a disclaimer.
- **Drafts state only Register facts** (number, bytes, height, counts) read through `@bsh/degent-mint-sdk`; never an
  address, never a price or projection.
- Imports: only `@bsh/events` and `@bsh/degent-mint-sdk` (see `depends_on`); `pnpm lint:boundaries` fails otherwise.
- `brain/BRAIN.md` is a verbatim copy of the legacy v2.1 brain; its code references (`src/lib/content-classifier.js`)
  map to `src/content/classifier.ts` here. Edit the brain deliberately, with the owner.
- Verify with `pnpm --filter @bsh/degent-x-bot test` and `typecheck` before finishing.
