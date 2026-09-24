/** Entry point: `pnpm --filter @bsh/degent-studio dev|start`. */
import { serve } from '@hono/node-server';
import { loadConfig, ConfigError } from './config.js';
import { buildRuntime } from './wiring.js';
import { jsonLogger } from './application/logger.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const rt = buildRuntime(cfg, log);
  // Dev keys are secrets for a throwaway regtest process: printed once, never logged as fields.
  for (const k of rt.devApiKeys) process.stderr.write(`dev API key ${k.id} (${k.scopes.join(', ')}): ${k.key}\n`);
  const server = serve({ fetch: rt.app.fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-studio listening', { network: cfg.settings.network, host: cfg.host, port: cfg.port, siwbDomain: cfg.settings.siwb.domain, visionReview: cfg.settings.visionReview });
  const shutdown = (sig: string) => {
    log.info('shutting down', { signal: sig });
    server.close();
    rt.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  if (e instanceof ConfigError) log.error('configuration error', { problems: e.problems });
  else log.error('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
