const { pgTable, uuid, varchar, text, timestamp, bigint, integer, boolean, real, jsonb, date, uniqueIndex } = require('drizzle-orm/pg-core');

// Content queue: all pending, approved, and posted content
const contentQueue = pgTable('content_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentType: varchar('content_type', { length: 50 }).notNull(), // 'meme', 'alpha', 'engagement', 'community', 'cta', 'repost', 'gm', 'fomo'
  source: varchar('source', { length: 50 }).notNull(), // 'ai_generated', 'telegram', 'manual', 'scheduled'
  status: varchar('status', { length: 20 }).notNull().default('pending'), // 'pending', 'approved', 'posted', 'rejected', 'failed'

  // Content
  textContent: text('text_content'),
  mediaUrls: jsonb('media_urls').$type(), // array of media URLs (S3/R2)
  threadTweets: jsonb('thread_tweets'), // for threads: [{text, media_url}]

  // Telegram source metadata
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  telegramUser: varchar('telegram_user', { length: 255 }),
  telegramUsername: varchar('telegram_username', { length: 255 }),
  telegramEngagementScore: real('telegram_engagement_score'),

  // Scheduling
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  postedAt: timestamp('posted_at', { withTimezone: true }),

  // X/Twitter metadata (after posting)
  tweetId: varchar('tweet_id', { length: 50 }),
  tweetUrl: text('tweet_url'),

  // AI metadata
  aiModel: varchar('ai_model', { length: 50 }),
  aiPromptUsed: text('ai_prompt_used'),
  contentScore: real('content_score'),

  // Approval
  approvalTier: varchar('approval_tier', { length: 20 }).default('auto'), // 'auto', 'review', 'manual'
  approvedBy: varchar('approved_by', { length: 100 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Engagement actions taken by the bot
const engagementLog = pgTable('engagement_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actionType: varchar('action_type', { length: 20 }).notNull(), // 'like', 'retweet', 'quote_tweet', 'reply', 'follow'
  targetTweetId: varchar('target_tweet_id', { length: 50 }),
  targetUserId: varchar('target_user_id', { length: 50 }),
  targetUsername: varchar('target_username', { length: 255 }),

  // For replies and quote tweets
  responseText: text('response_text'),
  responseTweetId: varchar('response_tweet_id', { length: 50 }),

  // Strategy metadata
  engagementTier: integer('engagement_tier'),
  engagementReason: varchar('engagement_reason', { length: 255 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Tracked accounts for engagement
const trackedAccounts = pgTable('tracked_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  twitterUserId: varchar('twitter_user_id', { length: 50 }).unique().notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  tier: integer('tier').notNull().default(2), // 1, 2, or 3
  category: varchar('category', { length: 50 }), // 'ordinals_project', 'bitcoin_influencer', 'marketplace', 'wallet', 'media', 'competitor'

  // Engagement tracking
  lastEngagedAt: timestamp('last_engaged_at', { withTimezone: true }),
  totalEngagements: integer('total_engagements').default(0),
  engagementFrequency: varchar('engagement_frequency', { length: 20 }).default('daily'),

  isActive: boolean('is_active').default(true),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Performance metrics per post
const postMetrics = pgTable('post_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  contentQueueId: uuid('content_queue_id').references(() => contentQueue.id),
  tweetId: varchar('tweet_id', { length: 50 }).notNull(),

  // Metrics (updated periodically)
  impressions: bigint('impressions', { mode: 'number' }).default(0),
  likes: integer('likes').default(0),
  retweets: integer('retweets').default(0),
  replies: integer('replies').default(0),
  quoteTweets: integer('quote_tweets').default(0),
  bookmarks: integer('bookmarks').default(0),
  linkClicks: integer('link_clicks').default(0),
  profileVisits: integer('profile_visits').default(0),

  // Calculated
  engagementRate: real('engagement_rate').default(0),

  // Snapshots
  metrics1h: jsonb('metrics_1h'),
  metrics24h: jsonb('metrics_24h'),
  metrics7d: jsonb('metrics_7d'),

  lastUpdated: timestamp('last_updated', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Daily aggregate metrics
const dailyMetrics = pgTable('daily_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  date: date('date').notNull().unique(),

  // Content
  postsCount: integer('posts_count').default(0),
  threadsCount: integer('threads_count').default(0),
  telegramReposts: integer('telegram_reposts').default(0),

  // Engagement given
  likesGiven: integer('likes_given').default(0),
  retweetsGiven: integer('retweets_given').default(0),
  repliesGiven: integer('replies_given').default(0),
  followsGiven: integer('follows_given').default(0),

  // Engagement received
  totalImpressions: bigint('total_impressions', { mode: 'number' }).default(0),
  totalLikes: integer('total_likes').default(0),
  totalRetweets: integer('total_retweets').default(0),
  totalReplies: integer('total_replies').default(0),

  // Growth
  followerCount: integer('follower_count').default(0),
  followerDelta: integer('follower_delta').default(0),

  // Conversion
  websiteClicks: integer('website_clicks').default(0),
  mintsAttributed: integer('mints_attributed').default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Telegram media archive
const telegramMedia = pgTable('telegram_media', {
  id: uuid('id').primaryKey().defaultRandom(),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }).notNull(),
  telegramChatId: bigint('telegram_chat_id', { mode: 'number' }).notNull(),
  telegramUserId: bigint('telegram_user_id', { mode: 'number' }),
  telegramUsername: varchar('telegram_username', { length: 255 }),

  // Media
  fileType: varchar('file_type', { length: 20 }).notNull(), // 'photo', 'video', 'gif', 'sticker'
  originalFileId: varchar('original_file_id', { length: 255 }),
  storedUrl: text('stored_url'),
  thumbnailUrl: text('thumbnail_url'),

  // Classification
  category: varchar('category', { length: 50 }),
  qualityScore: real('quality_score'),

  // Telegram engagement
  reactionCount: integer('reaction_count').default(0),
  forwardCount: integer('forward_count').default(0),

  // Twitter posting status
  isPosted: boolean('is_posted').default(false),
  contentQueueId: uuid('content_queue_id').references(() => contentQueue.id),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// System configuration
const botConfig = pgTable('bot_config', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

module.exports = {
  contentQueue,
  engagementLog,
  trackedAccounts,
  postMetrics,
  dailyMetrics,
  telegramMedia,
  botConfig,
};
