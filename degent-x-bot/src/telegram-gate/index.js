// Entrypoint: `npm run gate`.
//
// Runs three things in one process: the grammY bot (DM /verify), the Fastify
// callback server (/gate/*), and the BullMQ re-verification worker.

require('dotenv').config();

const config = require('./config');
const { collectGateProblems } = require('./config');
const { validateConfig } = require('../config/validate');
const logger = require('../lib/logger');
const { getRedis, closeRedis } = require('../services/redis-client');
const { closeDb } = require('../services/database');
const { createHolderClient } = require('./holders');
const { createPostgresRepo } = require('./repo-postgres');
const { createMemoryRepo } = require('./repo-memory');
const { createGateService } = require('./service');
const { createGateBot } = require('./bot');
const { buildGateServer } = require('./server');
const { startReverifyWorker } = require('./worker');
const { verifySignature } = require('./message');

async function main() {
  logger.info('DEGENT TELEGRAM GATE starting');

  try {
    validateConfig(config, { logger });
    const gate = collectGateProblems(config);
    if (!gate.ok) {
      throw Object.assign(new Error(`Gate configuration invalid:\n  - ${gate.errors.join('\n  - ')}`), { problems: gate.errors });
    }
  } catch (err) {
    logger.fatal({ problems: err.problems }, err.message);
    process.exit(1);
  }

  const repo = process.env.GATE_REPO === 'memory' ? createMemoryRepo() : createPostgresRepo();
  if (process.env.GATE_REPO === 'memory') logger.warn('GATE_REPO=memory: verifications are not persisted');

  const holders = createHolderClient({
    baseUrl: config.gate.registerApiUrl,
    cacheTtlMs: config.gate.holderCacheTtlMs,
    logger,
  });

  // The bot is created first so the service can use its API adapter.
  let service;
  const { bot, telegram } = createGateBot({
    token: config.gate.botToken,
    getService: () => service,
    logger,
  });

  service = createGateService({ repo, holders, telegram, config, verifySig: verifySignature, logger });

  const server = await buildGateServer({ service, config, logger });
  await server.listen({ port: config.gate.port, host: '0.0.0.0' });
  logger.info({ port: config.gate.port }, 'gate: callback server listening');

  const reverify = await startReverifyWorker({
    connection: getRedis(),
    service,
    everyMs: config.gate.reverifyEveryMs,
    logger,
  });
  logger.info({ everyMs: config.gate.reverifyEveryMs }, 'gate: re-verification scheduled');

  bot.start({
    allowed_updates: ['message'],
    onStart: (info) => logger.info({ username: info.username }, 'gate: bot polling'),
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'gate: shutting down');
    try {
      await bot.stop();
      await reverify.stop();
      await server.close();
      await closeRedis();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'gate: shutdown error');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'gate: fatal');
  process.exit(1);
});
