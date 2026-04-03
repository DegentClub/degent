# DEGENT X BOT — Autonomous Twitter Agent for @degentclub

An AI-powered bot that autonomously posts viral content, engages with the Bitcoin ecosystem, and drives minting activity for the Degent NFT collection on Bitcoin Ordinals.

## Features

- **Content Engine** — AI-generated tweets (memes, alpha, engagement bait, community posts, CTAs) using Claude/GPT
- **Telegram Pipeline** — Monitors Degent TG group, ingests images/memes, classifies them, and reposts the best on X
- **Engagement Engine** — Strategically likes, retweets, replies, and quote-tweets across the Bitcoin ecosystem
- **Metrics Tracker** — Collects tweet performance data, aggregates daily/weekly metrics
- **Admin API** — Fastify REST API for content queue management, engagement controls, and system config
- **Scheduler** — BullMQ-powered job scheduling for automated posting, scanning, and metrics collection

## Quick Start

### 1. Prerequisites
- Node.js 20+
- PostgreSQL 16
- Redis 7
- X/Twitter API credentials (Basic or Pro tier)
- Anthropic API key (Claude) and/or OpenAI API key

### 2. Setup

```bash
# Copy env file and fill in your credentials
cp .env.example .env

# Install dependencies
npm install

# Start Postgres + Redis via Docker
docker compose up -d postgres redis

# Push database schema
npm run db:push

# Start the bot
npm start
```

### 3. Docker (Full Stack)

```bash
docker compose up -d
```

## Environment Variables

See `.env.example` for the full list. Key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `X_API_KEY` | Yes | Twitter API key |
| `X_API_SECRET` | Yes | Twitter API secret |
| `X_ACCESS_TOKEN` | Yes | Twitter access token |
| `X_ACCESS_TOKEN_SECRET` | Yes | Twitter access token secret |
| `X_BEARER_TOKEN` | Yes | Twitter bearer token |
| `ANTHROPIC_API_KEY` | Yes* | Claude API key (*or OPENAI_API_KEY) |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `TELEGRAM_BOT_TOKEN` | No | For Telegram pipeline |

## API Endpoints

### Auth
- `POST /api/auth/login` — Get JWT token

### Content
- `GET /api/content/queue` — View content queue
- `POST /api/content` — Manually add content
- `POST /api/content/generate` — Trigger AI generation
- `PATCH /api/content/:id/approve` — Approve pending content
- `PATCH /api/content/:id/reject` — Reject content

### Engagement
- `GET /api/engagement/log` — View engagement actions
- `GET /api/engagement/accounts` — View tracked accounts
- `POST /api/engagement/accounts` — Add tracked account

### Metrics
- `GET /api/metrics/daily` — Daily metrics
- `GET /api/metrics/posts` — Per-post performance
- `GET /api/metrics/top-posts` — Top performing posts

### System
- `GET /api/health` — Health check
- `GET /api/config` — Bot configuration
- `POST /api/system/pause` — Pause bot
- `POST /api/system/resume` — Resume bot

## Architecture

```
src/
├── api/              # Fastify REST API
├── config/           # Configuration & defaults
├── db/               # Drizzle ORM schema
├── lib/              # Rate limiter, safety checker, dedup, logger
├── modules/
│   ├── content-engine/      # AI content generation
│   ├── telegram-pipeline/   # TG group monitoring & media ingestion
│   ├── engagement-engine/   # Strategic engagement automation
│   ├── metrics-tracker/     # Performance data collection
│   └── orchestrator/        # BullMQ scheduler & job workers
├── services/         # Twitter, AI, Redis, S3 clients
└── index.js          # Entry point
```

## The Agent Brain

The bot's personality, voice, and strategy are defined in `brain/DGENT_TWITTER_AGENT_BRAIN.md`. This file is loaded at runtime for every AI generation call. Edit it to tune the bot's behavior without code changes.

## Job Schedule

| Job | Frequency | Description |
|-----|-----------|-------------|
| Post Content | Every 2.5 hours | Generate & post tweets |
| Scan Timelines | Every 30 min | Engage with tracked accounts |
| Respond to Mentions | Every 15 min | Reply to @degentclub mentions |
| Fetch Metrics | Every 1 hour | Collect tweet performance data |
| Daily Report | 11 PM EST | Aggregate daily metrics |
