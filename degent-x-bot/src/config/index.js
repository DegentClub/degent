require('dotenv').config();

const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // X/Twitter API
  twitter: {
    apiKey: process.env.X_API_KEY,
    apiSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
    bearerToken: process.env.X_BEARER_TOKEN,
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    groupChatId: process.env.TELEGRAM_GROUP_CHAT_ID,
  },

  // AI
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openrouterKey: process.env.OPENROUTER_KEY,
    primaryModel: process.env.AI_PRIMARY_MODEL || 'claude-sonnet-4-6',
    fallbackModel: process.env.AI_FALLBACK_MODEL || 'gpt-4o',
  },

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://dgentx:dgentx@localhost:5432/dgentx',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Storage (S3/R2)
  storage: {
    bucket: process.env.S3_BUCKET || 'degent-media',
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
  },

  // Admin
  admin: {
    jwtSecret: process.env.JWT_SECRET || 'change-me-to-a-random-secret',
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'change-me',
  },

  // Alerts
  alerts: {
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    telegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID,
  },

  // Feature Flags
  features: {
    autoPostEnabled: process.env.AUTO_POST_ENABLED !== 'false',
    autoEngageEnabled: process.env.AUTO_ENGAGE_ENABLED !== 'false',
    telegramPipelineEnabled: process.env.TELEGRAM_PIPELINE_ENABLED !== 'false',
    reviewQueueEnabled: process.env.REVIEW_QUEUE_ENABLED !== 'false',
  },
};

module.exports = config;
