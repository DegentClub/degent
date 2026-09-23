# Operations

How to run, configure and supervise the DEGENT X BOT.

## Environment variables

Copy `.env.example` to `.env`. Everything the bot reads lives in
`src/config/index.js`; startup validation lives in `src/config/validate.js`.

### Required in production (startup refuses to run without them)

| Variable | Rule |
|----------|------|
| `JWT_SECRET` | >= 32 chars, not a placeholder. `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | >= 12 chars, not `change-me` / `admin` / `password` |
| `DATABASE_URL` | Must not be the built-in `dgentx:dgentx@localhost` default |
| `REDIS_URL` | Must be a valid URL. A passwordless URL to a non-localhost host logs a warning |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | Required by `docker compose` (it derives the URLs above from them) |

Validation runs first thing in `src/index.js`:

- `NODE_ENV=production` — any violation aborts with exit code 1 and a list of problems.
- `NODE_ENV=test` — same, unless `ALLOW_INSECURE_DEFAULTS=true` is set explicitly (the vitest config sets it).
- `NODE_ENV=development` — warnings only.

### Credentials

| Variable | Purpose |
|----------|---------|
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_BEARER_TOKEN` | X/Twitter API |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_KEY` | At least one AI provider |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_CHAT_ID` | Telegram ingestion (optional) |
| `S3_*` | Media storage (optional) |
| `DISCORD_WEBHOOK_URL`, `ALERT_TELEGRAM_CHAT_ID` | Alerts (optional) |

### Feature flags

| Variable | Default | Effect |
|----------|---------|--------|
| `REVIEW_QUEUE_ENABLED` | `true` | `true`: nothing posts without a human approving it. `false`: `auto` tier content posts on its own; `review` and `manual` still wait. |
| `AUTO_POST_ENABLED` | `true` | Master switch for the post-content job |
| `AUTO_ENGAGE_ENABLED` | `true` | Likes / replies / quote tweets |
| `TELEGRAM_PIPELINE_ENABLED` | `true` | Telegram → queue bridge |

### Other

| Variable | Default | Purpose |
|----------|---------|---------|
| `BRAIN_PATH` | `brain/DEGENT_X_BOT_BRAIN.md` | Override the agent brain file |
| `PORT` | `3000` | Admin API port |
| `LOG_LEVEL` | `info` | pino level |

## Secrets handling

- `.env` is git-ignored. Never commit it.
- The compose file binds the API to `127.0.0.1:3000` and does **not** publish
  Postgres or Redis on the host. Reach them with
  `docker compose exec postgres psql -U dgentx` /
  `docker compose exec redis redis-cli -a "$REDIS_PASSWORD"`.
- Redis runs with `--requirepass`; Postgres with the password from `.env`.
- Rotate `JWT_SECRET` to invalidate every admin session at once.

## Running

```bash
cp .env.example .env            # fill in secrets
docker compose up -d            # postgres + redis + bot, with healthchecks
docker compose ps               # all three should be "healthy"
docker compose logs -f degent-x-bot
```

Without Docker: set `DATABASE_URL` / `REDIS_URL` to reachable services,
`npm run db:push`, `npm start`.

## The approval tiers

Every piece of outbound text is classified by `src/lib/content-classifier.js`
before it is inserted into `content_queue`:

| Tier | What lands here | Auto-posts? |
|------|-----------------|-------------|
| `auto` | memes, gm, replies, community banter | Only when `REVIEW_QUEUE_ENABLED=false` |
| `review` | anything with a number (mint counts, GB, sat/vB, %), partnership / announcement language | Never — a human approves |
| `manual` | dollar amounts, floor/price talk, `Nx` multipliers, guaranteed / ROI / invest, "at completion", token talk | Never — a human writes or approves it |

Classification is text-based and deterministic; the content type requested
from the model does not override it. "NFA." is appended only to review-tier
market talk, and never to manual-tier content. See `README.md` → "Safety &
approval tiers" for the rationale.

## Reviewing the queue

All admin endpoints need a JWT: `POST /api/auth/login` with
`ADMIN_USERNAME` / `ADMIN_PASSWORD`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}' | jq -r .token)

# What is waiting
curl -s localhost:3000/api/content/queue?status=pending -H "authorization: Bearer $TOKEN" \
  | jq '.items[] | {id, approvalTier, contentType, textContent}'

# Approve — records your username as approvedBy; manual-tier content is only
# eligible to post once approvedBy is set.
curl -s -X PATCH localhost:3000/api/content/<id>/approve -H "authorization: Bearer $TOKEN"

# Reject
curl -s -X PATCH localhost:3000/api/content/<id>/reject -H "authorization: Bearer $TOKEN"
```

The post-content job (every 2.5 h) takes the oldest `approved` row first; if
none is eligible it generates a new candidate and runs it through the
classifier.

Rows with `status = 'rejected'` and `source = 'ai_generated'` are candidates
that failed the safety check (wallet address, banned words, length) — useful
for tuning prompts, not for posting.

## Health

- `GET /api/health` — used by the compose healthcheck.
- `docker compose ps` — all services report `healthy` once Postgres and Redis
  answer and the API is up.

## Tests

```bash
npm test          # vitest run
npm run test:watch
```

CI (`.github/workflows/ci.yml`) runs the suite, syntax-checks every source
file, and verifies that `docker compose config` refuses to render without the
passwords and never publishes the database ports.
