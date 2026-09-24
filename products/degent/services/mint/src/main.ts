/** Entry point: `pnpm --filter @bsh/degent-mint dev|start`. */
import { serve } from '@hono/node-server';
import { loadConfig, ConfigError } from './config.js';
import { initialiseParent, startRuntime, StartupError, type StartedRuntime } from './wiring.js';
import { jsonLogger } from './application/logger.js';

const log = jsonLogger();

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  for (const w of cfg.warnings) log.warn(w, { event: 'config.warning' });

  // Set once the server runs; a bus loss before that is remembered and acted on as soon as it is set.
  let shutdown: ((reason: string, code: number) => void) | null = null;
  let lostEarly = false;
  const rt: StartedRuntime = await startRuntime(cfg, log, {
    // Broker gone: stop cleanly and let the supervisor restart us (platform/events README). Orders wait; nothing is lost
    // but events still in the backlog, which are logged by id (`event.publish.lost`).
    onBusLost: () => (shutdown ? shutdown('event bus lost', 1) : (lostEarly = true)),
  });
  await initialiseParent(rt, cfg, log).catch((e) => log.error('parent initialisation failed', { error: String(e) }));
  const server = serve({ fetch: rt.app.fetch, port: cfg.port, hostname: cfg.host });
  log.info('degent-mint listening', {
    network: cfg.settings.network,
    host: cfg.host,
    port: cfg.port,
    collectionAddress: rt.signer.collectionAddress(),
    signer: rt.signer.kind,
    bus: rt.bus.status().mode,
  });
  const stop = new AbortController();
  const worker = rt.worker.run(cfg.workerIntervalMs, stop.signal);
  let stopping = false;
  shutdown = (reason: string, code: number) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { reason });
    stop.abort();
    server.close();
    // Let the current tick finish (it may be mid-reveal), then flush events and close the bus and the store.
    void worker
      .then(() => rt.shutdown())
      .catch((e) => log.error('shutdown failed', { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => process.exit(code));
  };
  process.on('SIGINT', () => shutdown?.('SIGINT', 0));
  process.on('SIGTERM', () => shutdown?.('SIGTERM', 0));
  if (lostEarly) shutdown('event bus lost', 1);
}

main().catch((e) => {
  if (e instanceof ConfigError) log.error('configuration error', { problems: e.problems });
  else if (e instanceof StartupError) log.error('startup refused', { error: e.message });
  else log.error('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
