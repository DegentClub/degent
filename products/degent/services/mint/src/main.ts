/**
 * Entry point: `pnpm --filter @bsh/degent-mint dev|start`, or the bundled `node dist/main.mjs [api|worker|all]`.
 *
 * Roles (MINT_ROLE, or the first CLI argument, which wins):
 *   all     HTTP API + worker in one process (default; dev and single-container installs)
 *   api     HTTP API only (horizontal edge; the worker runs elsewhere against the same sqlite file)
 *   worker  worker loop only; serves GET /v1/health on PORT for liveness probes, nothing else
 * api and worker share DATABASE_PATH / CONTENT_DIR (sqlite WAL + optimistic versioning; same host only).
 * Run exactly ONE worker: the parent UTXO chain is strictly serial.
 */
import { serve } from '@hono/node-server';
import { loadConfig, ConfigError } from './config.js';
import { buildRuntime, initialiseParent } from './wiring.js';
import { jsonLogger } from './application/logger.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const argRole = process.argv[2];
  const cfg = loadConfig(argRole ? { ...process.env, MINT_ROLE: argRole } : process.env);
  const rt = buildRuntime(cfg, log);
  // Read-only mode never starts the worker (config refuses MINT_ROLE=worker there).
  const runWorker = cfg.role !== 'api' && cfg.mode === 'full' && rt.worker !== null;
  if (runWorker) await initialiseParent(rt, cfg, log).catch((e) => log.error('parent initialisation failed', { error: String(e) }));
  const fetch =
    cfg.role === 'worker'
      ? (req: Request) => (new URL(req.url).pathname === '/v1/health' && req.method === 'GET' ? rt.app.fetch(req) : new Response('not found', { status: 404 }))
      : rt.app.fetch;
  const server = serve({ fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-mint listening', { role: cfg.role, mode: cfg.mode, network: cfg.settings.network, host: cfg.host, port: cfg.port, collectionAddress: rt.signer?.collectionAddress() ?? null });
  const stop = new AbortController();
  const worker = runWorker && rt.worker ? rt.worker.run(cfg.workerIntervalMs, stop.signal) : Promise.resolve();
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
