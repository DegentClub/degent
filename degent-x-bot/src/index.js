require('dotenv').config();

const config = require('./config');
const { validateConfig } = require('./config/validate');
const logger = require('./lib/logger');
const { buildServer } = require('./api/server');
const { setupQueues, startWorkers, stopAll } = require('./modules/orchestrator/scheduler');
const { startBot, stopBot } = require('./modules/telegram-pipeline');
const { getDb } = require('./services/database');
const { getRedis } = require('./services/redis-client');
const { botConfig } = require('./db/schema');
const { defaultBotConfig } = require('./config/defaults');

async function seedBotConfig() {
  try {
    const db = getDb();
    const existing = await db.select().from(botConfig);
    if (existing.length === 0) {
      logger.info('Seeding default bot configuration');
      for (const [key, value] of Object.entries(defaultBotConfig)) {
        await db.insert(botConfig).values({ key, value, description: `Default ${key} config` });
      }
      logger.info('Default bot configuration seeded');
    }
  } catch (err) {
    logger.warn({ err }, 'Could not seed bot config (DB may not be ready)');
  }
}

async function main() {
  logger.info('=========================================');
  logger.info('   DEGENT X BOT Starting...             ');
  logger.info('=========================================');
  logger.info({ nodeEnv: config.nodeEnv, port: config.port });

  // 0. Refuse to run with placeholder secrets outside development
  try {
    validateConfig(config, { logger });
  } catch (err) {
    logger.fatal({ problems: err.problems }, err.message);
    process.exit(1);
  }

  // 1. Initialize database connection
  try {
    getDb();
    logger.info('Database connection initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to connect to database');
    // Continue — DB will retry on first query
  }

  // 2. Initialize Redis
  try {
    getRedis();
    logger.info('Redis connection initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to connect to Redis');
  }

  // 3. Seed default config
  await seedBotConfig();

  // 4. Set up BullMQ queues and start workers
  try {
    setupQueues();
    startWorkers();
    logger.info('Orchestrator queues and workers started');
  } catch (err) {
    logger.error({ err }, 'Failed to start orchestrator');
  }

  // 5. Start Telegram bot (if configured)
  if (config.features.telegramPipelineEnabled && config.telegram.botToken) {
    try {
      startBot();
      logger.info('Telegram pipeline started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Telegram bot');
    }
  } else {
    logger.info('Telegram pipeline disabled or not configured');
  }

  // 6. Start Fastify API server
  const server = await buildServer();
  try {
    await server.listen({ port: config.port, host: '0.0.0.0' });
    logger.info({ port: config.port }, 'API server listening');
  } catch (err) {
    logger.error({ err }, 'Failed to start API server');
    process.exit(1);
  }

  logger.info('=========================================');
  logger.info('   DEGENT X BOT is LIVE. LFG.          ');
  logger.info('=========================================');

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received');
    try {
      await server.close();
      stopBot();
      await stopAll();
      const { closeDb } = require('./services/database');
      const { closeRedis } = require('./services/redis-client');
      await closeDb();
      await closeRedis();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error in main');
  process.exit(1);
});
