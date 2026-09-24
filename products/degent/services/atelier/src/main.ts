/** Entry point: `pnpm --filter @bsh/degent-atelier dev|start`. */
import { serve } from '@hono/node-server';
import { ConfigError, loadConfig } from './config.js';
import { jsonLogger } from './application/logger.js';
import { buildRuntime } from './wiring.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const rt = buildRuntime(cfg, log);
  const server = serve({ fetch: rt.app.fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-atelier listening', { host: cfg.host, port: cfg.port, mode: cfg.mode, provider: rt.provider.name, dailyCostCapCents: cfg.quotas.globalDailyCostCents });
  if (cfg.mode === 'fake') log.warn('no provider key configured: running in fake mode (procedural placeholder art)');
  const stop = new AbortController();
  const worker = rt.service.runWorker(cfg.workerIntervalMs, stop.signal);
  const shutdown = (sig: string) => {
    log.info('shutting down', { signal: sig });
    stop.abort();
    server.close();
    void worker.finally(() => {
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
