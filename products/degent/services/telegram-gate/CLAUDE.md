# @bsh/degent-telegram-gate - agent notes

Read the root `CLAUDE.md` and `products/degent/CLAUDE.md` first, then this package's `README.md`. Local rules:

- Kind: **service** (Hono + grammY, ports and adapters). Manifest: `component.yaml`; the catalog entry is generated.
- **No signature code here.** Challenges, BIP-322 / legacy verification, nonces and sessions are `@bsh/identity`
  (`issueChallenge`, `verifySignIn`, `NonceStore`, `SessionKeyRing`). Change them in DegentClub/scribbit.
- **Holdings come from the Register only** (`GET /v1/register/holder/{address}` via `@bsh/degent-mint-sdk`). An error
  from it must never revoke or kick anyone; an empty answer is the only "not a holder".
- **The invite link is only ever sent by Telegram DM.** No HTTP response, log line or error may contain it.
- Imports: only `@bsh/identity` and `@bsh/degent-mint-sdk` (see `depends_on`); `pnpm lint:boundaries` fails otherwise.
- Contract first: `contracts/openapi/degent-telegram-gate.yaml`. `test/contract.test.ts` checks routes, error codes and
  live responses; the web page's request shape is checked in `apps/web/test/gate-contract.test.ts`.
- Tests use the in-memory adapters (`MemoryTelegramApi`, `MemoryMemberStore`, `MemoryHolderRegistry`) and keys
  generated in the test; nothing touches Telegram or mainnet.
- Verify with `pnpm --filter @bsh/degent-telegram-gate test` and `typecheck` before finishing.
