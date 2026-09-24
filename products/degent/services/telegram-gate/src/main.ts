/** Entry point: `pnpm --filter @bsh/degent-telegram-gate dev|start`. One process: HTTP callbacks, the DM bot, re-verification. */
import { serve } from '@hono/node-server';
import { runEvery } from './application/scheduler.js';
import { jsonLogger } from './application/logger.js';
import { ConfigError, loadConfig } from './config.js';
import { buildRuntime } from './wiring.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const rt = buildRuntime(cfg, log);
  const server = serve({ fetch: rt.app.fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-telegram-gate listening', { network: cfg.settings.network, host: cfg.host, port: cfg.port, webBaseUrl: cfg.settings.webBaseUrl });

  const stop = new AbortController();
  const reverify = runEvery(cfg.reverifyIntervalMs, () => rt.service.reverifyAll(), stop.signal, log);
  if (rt.bot) {
    void rt.bot.start({ allowed_updates: ['message'], onStart: (info) => log.info('gate: bot polling', { username: info.username }) });
  }

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    stop.abort();
    server.close();
    void Promise.all([rt.bot?.stop(), reverify]).finally(() => {
      rt.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  if (e instanceof ConfigError) log.error('configuration error', { problems: e.problems });
  else log.error('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
