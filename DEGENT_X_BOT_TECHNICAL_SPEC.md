# DEGENT X BOT TWITTER AGENT — TECHNICAL BUILD SPECIFICATION
## Complete Engineering Blueprint for AI Code Builder

Version: 1.0
Project: DEGENT X BOT Autonomous Twitter Agent
Stack: Node.js/TypeScript + Python + PostgreSQL + Redis + AI (Claude/GPT)

---

## 1. SYSTEM OVERVIEW

### What We're Building

An autonomous AI-powered Twitter agent that:
1. Generates and posts viral memes and content to @degentclub on X/Twitter
2. Ingests images and memes from the Degent Telegram group and reposts them on X
3. Strategically engages with the Bitcoin ecosystem (likes, retweets, replies, quote tweets)
4. Drives minting activity, secondary market purchases, and website traffic for degent.club
5. Operates 24/7 with minimal human intervention, with a review queue for sensitive content

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    DEGENT X BOT AGENT CORE                    │
│                   (Node.js/TypeScript)                    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Content   │  │ Telegram │  │ Engage   │  │ Metrics │ │
│  │ Engine    │  │ Pipeline │  │ Engine   │  │ Tracker │ │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └────┬────┘ │
│        │              │              │             │      │
│  ┌─────┴──────────────┴──────────────┴─────────────┴───┐ │
│  │              SCHEDULER & ORCHESTRATOR                │ │
│  └─────────────────────┬───────────────────────────────┘ │
│                        │                                  │
│  ┌─────────────────────┴───────────────────────────────┐ │
│  │                   AI BRAIN LAYER                     │ │
│  │          (Claude API / GPT-4 / Local LLM)           │ │
│  └─────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│                   EXTERNAL SERVICES                      │
│  ┌──────┐ ┌──────────┐ ┌──────┐ ┌────────┐ ┌────────┐  │
│  │ X API│ │Telegram   │ │Redis │ │Postgres│ │S3/R2   │  │
│  │      │ │Bot API    │ │Cache │ │   DB   │ │Storage │  │
│  └──────┘ └──────────┘ └──────┘ └────────┘ └────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 2. TECHNOLOGY STACK

### Core Runtime
- **Language:** Javascript
- **Framework:** Fastify (API server for admin dashboard + webhooks)
- **Task Scheduler:** BullMQ (Redis-backed job queue)
- **ORM:** Drizzle ORM (PostgreSQL)
- **Containerization:** Docker + Docker Compose

### External APIs
- **X/Twitter API v2** (OAuth 2.0 with PKCE, elevated access for posting + engagement)
- **Telegram Bot API** (for monitoring group messages and media)
- **Claude API** (Anthropic) — primary AI brain for content generation
- **OpenAI API** (GPT-4o) — fallback/secondary AI for variety
- **Cloudflare R2 / AWS S3** — media storage for downloaded Telegram images

### Databases
- **PostgreSQL 16** — persistent storage (posts, metrics, content queue, engagement history)
- **Redis 7** — caching, rate limiting, job queue (BullMQ), real-time state

### Monitoring & Ops
- **Grafana + Prometheus** — metrics dashboards
- **Sentry** — error tracking
- **Uptime Kuma** — health checks
- **Discord/Telegram webhook** — admin alerts

---

## 3. DATABASE SCHEMA

### Tables

```sql
-- Content queue: all pending, approved, and posted content
CREATE TABLE content_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type VARCHAR(50) NOT NULL, -- 'meme', 'alpha', 'engagement', 'community', 'cta', 'repost'
    source VARCHAR(50) NOT NULL, -- 'ai_generated', 'telegram', 'manual', 'scheduled'
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'posted', 'rejected', 'failed'

    -- Content
    text_content TEXT, -- tweet text
    media_urls TEXT[], -- array of media URLs (S3/R2)
    thread_tweets JSONB, -- for threads: [{text, media_url}]

    -- Telegram source metadata
    telegram_message_id BIGINT,
    telegram_user VARCHAR(255),
    telegram_username VARCHAR(255),
    telegram_engagement_score FLOAT, -- calculated from reactions/forwards

    -- Scheduling
    scheduled_for TIMESTAMPTZ,
    posted_at TIMESTAMPTZ,

    -- X/Twitter metadata (after posting)
    tweet_id VARCHAR(50),
    tweet_url TEXT,

    -- AI metadata
    ai_model VARCHAR(50), -- which model generated it
    ai_prompt_used TEXT, -- the prompt that generated this content
    content_score FLOAT, -- AI-predicted engagement score (0-100)

    -- Approval
    approval_tier VARCHAR(20) DEFAULT 'auto', -- 'auto', 'review', 'manual'
    approved_by VARCHAR(100),

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Engagement actions taken by the bot
CREATE TABLE engagement_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_type VARCHAR(20) NOT NULL, -- 'like', 'retweet', 'quote_tweet', 'reply', 'follow'
    target_tweet_id VARCHAR(50),
    target_user_id VARCHAR(50),
    target_username VARCHAR(255),

    -- For replies and quote tweets
    response_text TEXT,
    response_tweet_id VARCHAR(50),

    -- Strategy metadata
    engagement_tier INT, -- 1=must engage, 2=regular, 3=opportunistic
    engagement_reason VARCHAR(255), -- why the bot engaged

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tracked accounts for engagement
CREATE TABLE tracked_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    twitter_user_id VARCHAR(50) UNIQUE NOT NULL,
    username VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    tier INT NOT NULL DEFAULT 2, -- 1, 2, or 3
    category VARCHAR(50), -- 'ordinals_project', 'bitcoin_influencer', 'marketplace', 'wallet', 'media', 'competitor'

    -- Engagement tracking
    last_engaged_at TIMESTAMPTZ,
    total_engagements INT DEFAULT 0,
    engagement_frequency VARCHAR(20) DEFAULT 'daily', -- 'daily', '3x_week', 'weekly', 'opportunistic'

    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance metrics per post
CREATE TABLE post_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_queue_id UUID REFERENCES content_queue(id),
    tweet_id VARCHAR(50) NOT NULL,

    -- Metrics (updated periodically)
    impressions BIGINT DEFAULT 0,
    likes INT DEFAULT 0,
    retweets INT DEFAULT 0,
    replies INT DEFAULT 0,
    quote_tweets INT DEFAULT 0,
    bookmarks INT DEFAULT 0,
    link_clicks INT DEFAULT 0,
    profile_visits INT DEFAULT 0,

    -- Calculated
    engagement_rate FLOAT DEFAULT 0, -- (likes+RTs+replies+QTs) / impressions

    -- Snapshots
    metrics_1h JSONB,  -- snapshot at 1 hour
    metrics_24h JSONB, -- snapshot at 24 hours
    metrics_7d JSONB,  -- snapshot at 7 days

    last_updated TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily aggregate metrics
CREATE TABLE daily_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL UNIQUE,

    -- Content
    posts_count INT DEFAULT 0,
    threads_count INT DEFAULT 0,
    telegram_reposts INT DEFAULT 0,

    -- Engagement given
    likes_given INT DEFAULT 0,
    retweets_given INT DEFAULT 0,
    replies_given INT DEFAULT 0,
    follows_given INT DEFAULT 0,

    -- Engagement received
    total_impressions BIGINT DEFAULT 0,
    total_likes INT DEFAULT 0,
    total_retweets INT DEFAULT 0,
    total_replies INT DEFAULT 0,

    -- Growth
    follower_count INT DEFAULT 0,
    follower_delta INT DEFAULT 0,

    -- Conversion
    website_clicks INT DEFAULT 0,
    mints_attributed INT DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Telegram media archive
CREATE TABLE telegram_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_message_id BIGINT NOT NULL,
    telegram_chat_id BIGINT NOT NULL,
    telegram_user_id BIGINT,
    telegram_username VARCHAR(255),

    -- Media
    file_type VARCHAR(20) NOT NULL, -- 'photo', 'video', 'gif', 'sticker'
    original_file_id VARCHAR(255),
    stored_url TEXT, -- S3/R2 URL
    thumbnail_url TEXT,

    -- Classification
    category VARCHAR(50), -- 'meme', 'fan_art', 'screenshot', 'community', 'trait_showcase', 'other'
    quality_score FLOAT, -- 0-100, AI-assessed

    -- Telegram engagement
    reaction_count INT DEFAULT 0,
    forward_count INT DEFAULT 0,

    -- Twitter posting status
    is_posted BOOLEAN DEFAULT FALSE,
    content_queue_id UUID REFERENCES content_queue(id),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- System configuration
CREATE TABLE bot_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. MODULE SPECIFICATIONS

### Module 1: Content Engine (`/src/modules/content-engine/`)

**Purpose:** Generate original tweet content using AI, following the brand voice and strategy defined in the Agent Brain markdown.

**Key Files:**
```
content-engine/
├── index.ts                  # Module exports
├── generator.ts              # Main content generation orchestrator
├── prompts/
│   ├── base-system.ts        # System prompt (loads DGENT_TWITTER_AGENT_BRAIN.md)
│   ├── meme-generator.ts     # Meme text generation prompts
│   ├── alpha-thread.ts       # Market commentary / alpha thread prompts
│   ├── engagement-bait.ts    # Polls, questions, hot takes prompts
│   ├── community-spotlight.ts # Holder highlight prompts
│   ├── gm-generator.ts       # Creative GM post prompts
│   ├── cta-generator.ts      # Mint/buy call-to-action prompts
│   └── reply-generator.ts    # Reply generation for engagement
├── scorer.ts                 # AI-based content quality scoring (0-100)
├── scheduler.ts              # Content calendar / time slot allocation
├── approval.ts               # Auto-approve / review queue routing
└── templates/
    ├── thread-formats.ts     # Thread structure templates
    └── tweet-formats.ts      # Single tweet structure templates
```

**Content Generation Flow:**
```
1. Scheduler triggers → "Need a MEME post for 12:00 PM slot"
2. Generator selects prompt template for content type
3. AI generates 3-5 candidate tweets
4. Scorer evaluates each candidate (engagement prediction, brand alignment, checklist)
5. Best candidate enters content_queue with appropriate approval tier
6. Auto-approved content posts at scheduled time
7. Review-tier content sends notification to admin for approval
```

**AI Prompt Structure:**
```typescript
interface ContentRequest {
  contentType: 'meme' | 'alpha' | 'engagement' | 'community' | 'cta' | 'gm' | 'fomo';
  timeSlot: string; // e.g., "morning_gm", "noon_meme", "evening_engagement"
  context: {
    recentTrending: string[];      // Current trending topics on X
    bitcoinPrice: number;           // Current BTC price
    recentMints: number;            // Mints in last 24h
    floorPrice: number;             // Current floor price in BTC
    recentTopPosts: string[];       // Our top-performing recent posts
    communityMoments: string[];     // Recent TG highlights
    competitorActivity: string[];   // What competitors posted recently
  };
  constraints: {
    maxLength: 280;
    includeMedia: boolean;
    includeLink: boolean;
    targetUrl?: string;
  };
}
```

### Module 2: Telegram Pipeline (`/src/modules/telegram-pipeline/`)

**Purpose:** Monitor the Degent Telegram group, ingest images/memes, classify them, store them, and queue the best ones for posting on X.

**Key Files:**
```
telegram-pipeline/
├── index.ts
├── bot.ts                    # Telegram Bot client (grammy or telegraf)
├── media-handler.ts          # Download, process, store media
├── classifier.ts             # AI-based image classification + quality scoring
├── content-bridge.ts         # Bridge TG content → content_queue for X posting
├── monitor.ts                # Real-time group message monitoring
└── config.ts                 # Group IDs, filter settings
```

**Pipeline Flow:**
```
1. Telegram Bot monitors DGENT group via long polling or webhook
2. On new message with media:
   a. Download media file from Telegram servers
   b. Upload to S3/R2 storage
   c. AI classifies image: category (meme/fan_art/screenshot/etc.) + quality score
   d. Store metadata in telegram_media table
   e. If quality_score > 70:
      - Generate tweet text to accompany the image
      - Credit original poster
      - Add to content_queue with source='telegram'
      - Route to appropriate time slot
3. High-engagement TG content (many reactions) gets priority posting
4. Whale alert screenshots get IMMEDIATE posting (< 15 min)
```

**Image Classification Prompt:**
```typescript
const classificationPrompt = `
Analyze this image from the Degent NFT community Telegram group.

Classify it into one of these categories:
- MEME: Funny content, reaction images, market commentary memes
- FAN_ART: Original art featuring Degent characters or branding
- SCREENSHOT: Sales screenshots, floor price, whale alerts, marketplace activity
- COMMUNITY: Group photos, event pics, IRL content
- TRAIT_SHOWCASE: Showing off rare or cool Degent NFT traits
- SPAM: Irrelevant, low quality, or inappropriate content
- OTHER: Doesn't fit any category

Rate quality from 0-100 based on:
- Visual clarity and resolution (0-25)
- Relevance to Degent community (0-25)
- Viral/share potential for Twitter (0-25)
- Originality and creativity (0-25)

Return JSON: { category, quality_score, description, suggested_tweet_text }
`;
```

### Module 3: Engagement Engine (`/src/modules/engagement-engine/`)

**Purpose:** Strategically engage with the Bitcoin ecosystem on X — likes, retweets, quote tweets, replies, and follows — to build visibility and relationships.

**Key Files:**
```
engagement-engine/
├── index.ts
├── scanner.ts                # Scan timelines of tracked accounts for new tweets
├── evaluator.ts              # AI evaluates which tweets to engage with and how
├── executor.ts               # Execute engagement actions via X API
├── reply-crafter.ts          # Generate contextual replies
├── quote-crafter.ts          # Generate quote tweet text
├── follow-manager.ts         # Strategic follow/follow-back logic
├── mention-responder.ts      # Auto-respond to @degentclub mentions
├── rate-limiter.ts           # X API rate limit management
└── strategies/
    ├── tier1-daily.ts        # Must-engage accounts (daily)
    ├── tier2-regular.ts      # Regular engagement (3-5x/week)
    ├── tier3-opportunistic.ts # Opportunistic engagement
    ├── trending-jack.ts       # Hijack trending topics with Degent takes
    └── competitor-monitor.ts  # Monitor and counter-position vs competitors
```

**Engagement Decision Flow:**
```
1. Scanner pulls latest tweets from tracked accounts (paginated, rate-limited)
2. For each tweet, Evaluator runs AI assessment:
   - Relevance to Bitcoin/Ordinals/NFT space (0-100)
   - Engagement opportunity score (0-100)
   - Best action: like / retweet / quote_tweet / reply / skip
   - If reply/QT: generate the response text
3. Rate limiter checks: are we within safe API limits?
4. Executor performs the action
5. Log to engagement_log table
6. Track relationship score per account over time
```

**Engagement Budget (Per Day):**
```
Likes:          50-100
Retweets:       10-20
Quote Tweets:   5-10
Replies:        20-40
Follows:        10-30
```

**Reply Generation Rules:**
- Must be contextual to the original tweet
- Must subtly reference Degent when natural (not forced)
- Must add value: humor, insight, or relevant information
- Must match the brand voice from the Agent Brain
- Never sycophantic, never generic ("Great tweet!")

### Module 4: Metrics Tracker (`/src/modules/metrics-tracker/`)

**Purpose:** Track all performance metrics, generate reports, and feed data back into the AI for content optimization.

**Key Files:**
```
metrics-tracker/
├── index.ts
├── collector.ts              # Fetch tweet metrics from X API
├── aggregator.ts             # Compute daily/weekly/monthly aggregates
├── reporter.ts               # Generate metric reports
├── optimizer.ts              # Feed performance data back to Content Engine
├── alerts.ts                 # Alert on anomalies (viral tweet, engagement drop, etc.)
└── dashboard-api.ts          # API endpoints for admin dashboard
```

**Metric Collection Schedule:**
```
- Every tweet: Check metrics at 1h, 6h, 24h, 72h, 7d after posting
- Daily: Aggregate all metrics into daily_metrics table
- Weekly: Generate performance report
- Monthly: Generate comprehensive analytics report
```

### Module 5: Scheduler & Orchestrator (`/src/modules/orchestrator/`)

**Purpose:** Central coordination layer that manages timing, job execution, and inter-module communication.

**Key Files:**
```
orchestrator/
├── index.ts
├── scheduler.ts              # BullMQ job scheduling
├── calendar.ts               # Content calendar management
├── coordinator.ts            # Cross-module coordination
├── health-check.ts           # System health monitoring
└── jobs/
    ├── post-content.job.ts   # Post scheduled content to X
    ├── scan-timeline.job.ts  # Scan tracked accounts for engagement
    ├── fetch-metrics.job.ts  # Collect post metrics
    ├── telegram-sync.job.ts  # Process Telegram media queue
    ├── daily-report.job.ts   # Generate daily metrics report
    ├── trending-scan.job.ts  # Scan trending topics for newsjacking
    └── cleanup.job.ts        # Archive old data, clean caches
```

**Job Schedule:**
```
| Job                | Frequency        | Priority |
|--------------------|------------------|----------|
| post-content       | Every 2-3 hours  | HIGH     |
| scan-timeline      | Every 30 min     | HIGH     |
| telegram-sync      | Real-time        | HIGH     |
| fetch-metrics      | Every 1 hour     | MEDIUM   |
| trending-scan      | Every 15 min     | MEDIUM   |
| daily-report       | Once daily 11 PM | LOW      |
| cleanup            | Once daily 3 AM  | LOW      |
```

---

## 5. API ENDPOINTS (Admin Dashboard)

### Authentication
- JWT-based auth for admin dashboard
- API key auth for webhook endpoints

### Endpoints

```
# Content Management
GET    /api/content/queue          # View content queue (pending, approved, posted)
GET    /api/content/:id            # Get specific content item
POST   /api/content                # Manually add content to queue
PATCH  /api/content/:id/approve    # Approve pending content
PATCH  /api/content/:id/reject     # Reject pending content
POST   /api/content/generate       # Trigger AI content generation on-demand
DELETE /api/content/:id            # Remove from queue

# Telegram Pipeline
GET    /api/telegram/media         # View ingested Telegram media
GET    /api/telegram/media/:id     # Get specific media item
PATCH  /api/telegram/media/:id     # Update classification or approve for posting

# Engagement
GET    /api/engagement/log         # View engagement actions taken
GET    /api/engagement/accounts    # View tracked accounts
POST   /api/engagement/accounts    # Add tracked account
PATCH  /api/engagement/accounts/:id # Update account tier/settings
DELETE /api/engagement/accounts/:id # Remove tracked account

# Metrics
GET    /api/metrics/daily          # Daily metrics summary
GET    /api/metrics/weekly         # Weekly report
GET    /api/metrics/posts          # Per-post performance
GET    /api/metrics/top-posts      # Top performing posts (by timeframe)
GET    /api/metrics/growth         # Follower growth data

# System
GET    /api/health                 # Health check
GET    /api/config                 # Current bot configuration
PATCH  /api/config                 # Update configuration
POST   /api/system/pause           # Pause all automated posting
POST   /api/system/resume          # Resume automated posting
```

---

## 6. CONFIGURATION

### Environment Variables

```env
# X/Twitter API
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
X_BEARER_TOKEN=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_CHAT_ID=

# AI
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
AI_PRIMARY_MODEL=claude-sonnet-4-6
AI_FALLBACK_MODEL=gpt-4o

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/dgentx
REDIS_URL=redis://localhost:6379

# Storage
S3_BUCKET=dgent-media
S3_REGION=auto
S3_ENDPOINT=  # For R2 or compatible
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Admin
JWT_SECRET=
ADMIN_USERNAME=
ADMIN_PASSWORD=

# Alerts
DISCORD_WEBHOOK_URL=
ALERT_TELEGRAM_CHAT_ID=

# Feature Flags
AUTO_POST_ENABLED=true
AUTO_ENGAGE_ENABLED=true
TELEGRAM_PIPELINE_ENABLED=true
REVIEW_QUEUE_ENABLED=true
```

### Bot Configuration (Stored in DB)

```json
{
  "posting": {
    "min_posts_per_day": 5,
    "max_posts_per_day": 10,
    "min_gap_between_posts_minutes": 90,
    "peak_hours_est": ["9-11", "12-14", "18-21"],
    "timezone": "America/New_York",
    "auto_approve_content_types": ["meme", "gm", "engagement"],
    "review_content_types": ["alpha", "cta", "controversy"]
  },
  "engagement": {
    "daily_like_budget": 75,
    "daily_retweet_budget": 15,
    "daily_reply_budget": 30,
    "daily_follow_budget": 20,
    "min_follower_count_to_engage": 100,
    "engagement_cooldown_per_account_hours": 4
  },
  "telegram": {
    "min_quality_score_to_post": 70,
    "whale_alert_immediate_post": true,
    "max_telegram_reposts_per_day": 5,
    "credit_original_poster": true
  },
  "content": {
    "content_mix": {
      "meme": 0.35,
      "alpha": 0.20,
      "community": 0.15,
      "cta": 0.10,
      "engagement": 0.10,
      "ecosystem": 0.10
    },
    "max_hashtags_per_tweet": 2,
    "include_media_percentage": 0.80,
    "thread_max_tweets": 7
  },
  "safety": {
    "banned_words": ["financial advice", "guaranteed returns", "pump"],
    "max_api_calls_per_15_min": 300,
    "pause_on_rate_limit": true,
    "auto_delete_flagged_content": false
  }
}
```

---

## 7. KEY IMPLEMENTATION DETAILS

### X API Rate Limit Management

```typescript
// Rate limit tracker - CRITICAL for avoiding suspension
interface RateLimitState {
  endpoint: string;
  limit: number;
  remaining: number;
  resetAt: Date;
}

// Use Redis for distributed rate limiting
class RateLimiter {
  // Track per-endpoint limits
  // X API v2 limits (as of 2026):
  // - POST tweets: 100 per 24h (Basic), 500 per 24h (Pro)
  // - POST likes: 1000 per 24h
  // - POST retweets: 100 per 24h (Basic), 500 (Pro)
  // - GET user timeline: 100 per 15 min
  // - GET search: 100 per 15 min (Basic), 500 (Pro)

  async canExecute(endpoint: string): Promise<boolean>;
  async recordUsage(endpoint: string): Promise<void>;
  async getBackoffTime(endpoint: string): Promise<number>;
}
```

### Content De-duplication

```typescript
// Prevent posting similar content
class ContentDeduplicator {
  // Use cosine similarity on tweet embeddings
  // Reject if similarity > 0.85 with any post from last 7 days
  async isDuplicate(newContent: string): Promise<boolean>;

  // Also check Telegram media by perceptual hash
  async isMediaDuplicate(imageBuffer: Buffer): Promise<boolean>;
}
```

### Telegram Media Processing

```typescript
// Image processing pipeline
class MediaProcessor {
  // 1. Download from Telegram servers
  async downloadMedia(fileId: string): Promise<Buffer>;

  // 2. Validate (size, format, resolution)
  async validate(buffer: Buffer): Promise<ValidationResult>;

  // 3. Optimize for X (compress, resize to optimal dimensions)
  // X image specs: max 5MB, JPG/PNG/GIF/WEBP, 1200x675 optimal
  async optimizeForTwitter(buffer: Buffer): Promise<Buffer>;

  // 4. Generate perceptual hash for de-duplication
  async generatePHash(buffer: Buffer): Promise<string>;

  // 5. Upload to S3/R2
  async uploadToStorage(buffer: Buffer, key: string): Promise<string>;

  // 6. AI classification
  async classify(imageUrl: string): Promise<ClassificationResult>;
}
```

### AI Content Generation Safety

```typescript
// Every AI-generated tweet goes through safety checks
class ContentSafetyChecker {
  async check(content: string): Promise<SafetyResult> {
    return {
      // Must pass ALL checks
      noFinancialAdvice: boolean,     // No price predictions, guarantees
      noWalletAddresses: boolean,     // No wallet addresses in tweets
      noBannedWords: boolean,         // Check against banned word list
      noExcessiveHashtags: boolean,   // Max 2 hashtags
      withinCharLimit: boolean,       // 280 chars max
      brandAligned: boolean,          // AI check against brand voice
      notDuplicate: boolean,          // De-dup check passed
      passesXTOS: boolean,            // No TOS violations
    };
  }
}
```

---

## 8. DEPLOYMENT

### Docker Compose

```yaml
version: '3.8'

services:
  dgentx-agent:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    depends_on:
      - postgres
      - redis
    restart: always
    volumes:
      - ./brain:/app/brain  # Mount the Agent Brain markdown

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: dgentx
      POSTGRES_USER: dgentx
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

  admin-dashboard:
    build:
      context: ./dashboard
    ports:
      - "3001:3001"
    depends_on:
      - dgentx-agent
    environment:
      - API_URL=http://dgentx-agent:3000

volumes:
  pgdata:
  redisdata:
```

### Recommended Hosting
- **Primary:** Railway or Render (easy Docker deployment, managed Postgres + Redis)
- **Alternative:** VPS on Hetzner (cheapest for always-on bots) or DigitalOcean
- **Media Storage:** Cloudflare R2 (free egress, cheapest for image storage)
- **Monitoring:** Grafana Cloud free tier + Sentry free tier

### Estimated Monthly Costs
```
| Service              | Cost/Month |
|----------------------|------------|
| Hosting (VPS/PaaS)  | $20-50     |
| PostgreSQL (managed) | $15-25     |
| Redis (managed)      | $10-15     |
| Cloudflare R2        | $5-10      |
| X API (Pro tier)     | $100/month |
| Claude API           | $30-80     |
| OpenAI API (backup)  | $10-20     |
| Sentry               | $0 (free)  |
| Monitoring           | $0 (free)  |
|----------------------|------------|
| TOTAL                | ~$190-300  |
```

---

## 9. PROJECT STRUCTURE

```
degent-x-bot/
├── src/
│   ├── modules/
│   │   ├── content-engine/
│   │   ├── telegram-pipeline/
│   │   ├── engagement-engine/
│   │   ├── metrics-tracker/
│   │   └── orchestrator/
│   ├── services/
│   │   ├── twitter-client.ts       # X API v2 client wrapper
│   │   ├── telegram-client.ts      # Telegram Bot API wrapper
│   │   ├── ai-client.ts            # Claude + GPT client abstraction
│   │   ├── storage-client.ts       # S3/R2 client
│   │   └── database.ts             # Drizzle ORM setup
│   ├── lib/
│   │   ├── rate-limiter.ts
│   │   ├── content-safety.ts
│   │   ├── deduplicator.ts
│   │   ├── media-processor.ts
│   │   └── logger.ts
│   ├── api/
│   │   ├── server.ts               # Fastify server
│   │   ├── routes/
│   │   │   ├── content.ts
│   │   │   ├── engagement.ts
│   │   │   ├── metrics.ts
│   │   │   ├── telegram.ts
│   │   │   └── system.ts
│   │   └── middleware/
│   │       └── auth.ts
│   ├── db/
│   │   ├── schema.ts               # Drizzle schema
│   │   └── migrations/
│   ├── config/
│   │   ├── index.ts
│   │   └── defaults.ts
│   └── index.ts                    # Entry point
├── brain/
│   └── DGENT_TWITTER_AGENT_BRAIN.md  # The AI personality/strategy doc
├── dashboard/                       # Admin dashboard (React/Next.js)
│   ├── src/
│   └── package.json
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env.example
└── README.md
```

---

## 10. BUILD ORDER (For AI Code Builder)

Execute in this exact sequence:

### Phase 1: Foundation (Week 1)
1. Initialize TypeScript project with all dependencies
2. Set up Docker Compose (Postgres + Redis)
3. Implement database schema with Drizzle migrations
4. Build X/Twitter API client wrapper with rate limiting
5. Build Telegram Bot API client
6. Build AI client abstraction (Claude primary, GPT fallback)
7. Build S3/R2 storage client

### Phase 2: Core Modules (Week 2)
8. Build Content Engine — AI content generation with prompts loaded from Brain markdown
9. Build Content Safety Checker and De-duplicator
10. Build Scheduler/Orchestrator with BullMQ jobs
11. Build basic posting pipeline: generate → approve → post
12. Test end-to-end: AI generates tweet → posts to X

### Phase 3: Telegram Pipeline (Week 3)
13. Build Telegram group monitor (real-time media ingestion)
14. Build media processor (download, optimize, store)
15. Build AI image classifier
16. Build Telegram-to-Twitter content bridge
17. Test end-to-end: image posted in TG → appears on X with caption

### Phase 4: Engagement Engine (Week 4)
18. Build timeline scanner for tracked accounts
19. Build AI engagement evaluator
20. Build reply and quote-tweet crafter
21. Build engagement executor with rate limiting
22. Build mention responder
23. Test end-to-end: bot finds relevant tweet → engages strategically

### Phase 5: Metrics & Dashboard (Week 5)
24. Build metrics collector (X API tweet metrics)
25. Build daily/weekly aggregation
26. Build admin REST API endpoints
27. Build React admin dashboard (content queue, metrics, controls)
28. Build alert system (Discord/Telegram webhooks)

### Phase 6: Polish & Deploy (Week 6)
29. Comprehensive error handling and retry logic
30. Health checks and monitoring setup
31. Load testing and rate limit stress testing
32. Security audit (API keys, auth, input sanitization)
33. Deploy to production
34. Monitor for 48 hours, tune parameters

---

## 11. CRITICAL SUCCESS FACTORS

1. **Never get the X account suspended.** Rate limiting and content safety are non-negotiable. Build conservatively, scale up gradually.

2. **The AI Brain markdown is the soul of the bot.** Every content generation call must load and follow the brand voice, persona, and strategy defined in DGENT_TWITTER_AGENT_BRAIN.md. This file should be hot-reloadable so the voice can be tuned without code deploys.

3. **Telegram pipeline must feel real-time.** Community members posting memes in TG should see them on the main Twitter within hours (whale alerts within minutes). This creates a flywheel of community content creation.

4. **Engagement must feel human.** Replies and quote tweets should be contextual, witty, and varied. Generic engagement will hurt the brand. Better to engage less but better.

5. **Metrics drive everything.** The system must learn from what works. Top-performing content types, best posting times, highest-engagement reply formats — all should feed back into the AI prompts over time.

---

*End of DEGENT X BOT Technical Specification v1.0*
