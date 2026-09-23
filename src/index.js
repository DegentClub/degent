import { createApp } from './app.js';

const { app, config, stmts, watcher, logger } = createApp();

const server = app.listen(config.port, () => {
  const { count } = stmts.countActive.get();
  logger.info(`Degent Marketplace on http://localhost:${config.port} [${config.network}]`);
  logger.info(`Active listings: ${count}`);
  logger.info(`Buys ${config.buysEnabled ? 'ENABLED' : 'PAUSED (BUYS_ENABLED=false)'}; royalty ${config.royaltyBps} bps${config.treasuryAddress ? ` -> ${config.treasuryAddress}` : ''}`);
  watcher.start();
});

function shutdown() {
  watcher.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
