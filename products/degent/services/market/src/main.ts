/** Entry point: `pnpm --filter @bsh/degent-market dev|start`. */
import { serve } from '@hono/node-server';
import { jsonLogger } from './application/logger.js';
import { ConfigError, loadConfig } from './config.js';
import { buildRuntime } from './wiring.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const rt = buildRuntime(cfg, log);
  const server = serve({ fetch: rt.app.fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-market listening', { network: cfg.settings.network, host: cfg.host, port: cfg.port, buysEnabled: cfg.settings.buysEnabled, royaltyBps: cfg.settings.royaltyBps });
  const stop = new AbortController();
  const watcher = rt.watcher.run(cfg.watcherIntervalMs, stop.signal);
  const shutdown = (sig: string) => {
    log.info('shutting down', { signal: sig });
    stop.abort();
    server.close();
    void watcher.finally(() => {
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
