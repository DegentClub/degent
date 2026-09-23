/** Fee server entry point: `pnpm --filter @bsh/fee-oracle dev | start`. */
import { serve } from '@hono/node-server';
import { ConfigError, loadServerConfig } from './config.js';
import { createFeeOracle } from './oracle.js';
import { createFeeServer } from './server.js';

function main(): void {
  let cfg;
  try {
    cfg = loadServerConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(2);
  }
  const oracle = createFeeOracle(cfg.oracle);
  const app = createFeeServer({ oracles: [oracle], corsOrigins: cfg.corsOrigins });
  serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
    console.log(
      JSON.stringify({
        msg: 'scribbit fee oracle listening',
        port: info.port,
        network: cfg.network,
        sources: cfg.oracle.sources.map((s) => s.id),
      }),
    );
  });
  // Warm the cache so the first request is not a cold fan-out.
  oracle.getFees().catch((e) => console.warn(JSON.stringify({ msg: 'initial fee poll failed', error: String(e?.message ?? e) })));
}

main();
