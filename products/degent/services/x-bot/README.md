# @bsh/degent-x-bot

The **content engine** of @degentclub on X: the deterministic approval-tier classifier, the content-safety gate, and
a drafts pipeline that turns Register facts into posts that wait for a human. Ported from
[Degent-X-Bot](https://github.com/antron3000/Degent-X-Bot) (`src/lib/content-classifier.js`,
`src/lib/content-safety.js`, `src/lib/bitcoin-address.js`, the approval rules of the post-content job, and their
tests). The account's voice and rules: [`brain/BRAIN.md`](brain/BRAIN.md) (verbatim copy of the v2.1 brain; its
`src/lib/content-classifier.js` is `src/content/classifier.ts` here).

## What it does

```
degent.mint.order.delivered  ──▶ DraftPipeline.onOrderStatus ──▶ Register: /v1/register/verify/{id}, /v1/register/{n}
  (@bsh/events, platform topic)       "Degent #4,113 joined the Club. 372 KB, block 912,345."
GET /v1/stats ───────────────▶ DraftPipeline.fromStats ──▶ milestone ("4,200 of 10,000 Degents. 1.51 GB …")
                                                            and last complete week ("This week 12 Degents joined …")
                                         │
                                         ▼
                              Publisher.submit ─▶ gateContent: classify ─▶ NFA (review market talk) ─▶ safety
                                         │
                   auto AND REVIEW_QUEUE_ENABLED=false AND safe AND POSTING_ENABLED ──▶ XClient.post
                   everything else ──▶ DraftStore (pending) ──▶ Publisher.approve(id, name) ──▶ publishApproved
```

- **Tiers** (`src/content/classifier.ts`): `manual` (dollar amounts, floor, price, `Nx`, ROI, invest, guarantees, "at
  completion", tokens/airdrops, market cap, profits, returns) never posts without a named human and is never unlocked
  by "NFA"; `review` (numbers with a fact marker: `4,113 of 10,000`, sizes, sat/vB, %, "minted" or "blockspace" with a
  number, partnerships, announcements) waits for a human; `auto` (gm, memes, clean replies) may post alone only with
  `REVIEW_QUEUE_ENABLED=false`. Strictest wins; `contentType` never downgrades.
- **Safety** (`src/content/safety.ts`): no address-shaped strings (bech32/bech32m any case, P2SH, P2PKH; the old
  regex never matched `bc1q…`), no banned phrases, ≤ 2 hashtags, ≤ 280 chars, not empty. `appendDisclaimer` adds
  "NFA." to review-tier market talk only, never twice, never past 280.
- **Approval rules** (`src/content/approval.ts`): only `approved` drafts post; `review` and `manual` need a named
  approver (a hand-edited "approved" row without one is refused and logged); safety is re-checked at posting time.
- **Drafts** (`src/drafts/`): only Register facts; one draft per fact (`member:<n>`, `milestone:<m>`, `week:<iso>`),
  so bus redeliveries and repeated stats runs add nothing. Register facts carry numbers, so these drafts are
  review tier: they never post on their own, whatever `REVIEW_QUEUE_ENABLED` says.

## Ports and adapters

| Port | Adapters |
|---|---|
| `XClient` | `HttpXClient` (X API v2 `POST /2/tweets`, user-context token), `MemoryXClient` (tests, dry runs) |
| `DraftStore` | `MemoryDraftStore` |
| `RegisterReader` | `createMintClient` from `@bsh/degent-mint-sdk` (a `Pick` of `MintClient`), fakes in tests |
| event feed | `DraftPipeline.attach(bus)` on any `@bsh/events` `EventBus` (`InMemoryBus`, `AmqpBusAdapter`) |

## Environment

`env.schema.json` is authoritative: `MINT_API_URL` (required), `REVIEW_QUEUE_ENABLED` (default on; only `false` turns
it off), `POSTING_ENABLED` (default `false`), `X_ACCESS_TOKEN` (secret `services/degent-x-bot/x-access-token`,
needed only to post), `MILESTONE_EVERY` (100). `pnpm --filter @bsh/degent-x-bot start` makes one pass over
`/v1/stats`, prints each draft with its tier and decision, and posts nothing unless the rules above allow it.

## Intentionally not ported

The full legacy bot stays on the branch **`legacy/degent-x-bot`** of DegentClub/degent (and in the original
repository); this package keeps only the parts that decide *what may be said*:

- **The LLM generation loop** (content engine prompts, time-slot scheduler, reply/mention monitors, image
  generation). Generated text is the riskiest input the account has; before it returns it needs its own design
  (prompt review, evals against the brain, a budget). When it does, its output must enter through
  `Publisher.submit` like every draft here — the gate does not trust its source.
- **The Postgres `content_queue`, BullMQ/Redis jobs, Fastify admin API and dashboard.** The queue is a port
  (`DraftStore`) with an in-memory adapter; a durable adapter (node:sqlite like the mint, or Postgres) and an
  operator surface for approve/reject come with the deployment decision, not before.
- **Rate limiter, de-duplicator, analytics, follower tracking.** Not needed for drafts; X API limits apply to the
  one posting path when posting is switched on.
- **The Telegram gate.** It is its own service now: `@bsh/degent-telegram-gate`.

## Development

```bash
pnpm --filter @bsh/degent-x-bot test        # classifier, address filter, safety, approval rules, publisher, drafts
pnpm --filter @bsh/degent-x-bot typecheck
MINT_API_URL=http://127.0.0.1:8787 pnpm --filter @bsh/degent-x-bot start   # dry run against a local mint
```
