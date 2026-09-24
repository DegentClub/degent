/**
 * Operator one-off (RUNBOOK section 8, "Re-leasing or re-initialising the parent"): move the stored parent
 * to a new outpoint after checking it on chain (collection script, value == PARENT_VALUE_SATS).
 *
 *   # service stopped, same environment as the service
 *   pnpm --filter @bsh/degent-mint exec tsx src/reinit-parent.ts <txid>:<vout>
 *
 * Refuses while an order is `revealing` or holds the parent lease. Logs `parent.lease.changed`; because the
 * value is checked first, it never opens the value circuit breaker.
 */
import { loadConfig, ConfigError } from './config.js';
import { reinitialiseParent, startRuntime } from './wiring.js';
import { jsonLogger } from './application/logger.js';

const log = jsonLogger('degent-mint-reinit-parent');

async function main(): Promise<void> {
  const m = /^([0-9a-f]{64}):(\d+)$/.exec(process.argv[2] ?? '');
  if (!m) throw new Error('usage: tsx src/reinit-parent.ts <txid>:<vout>');
  const cfg = loadConfig(process.env);
  const rt = await startRuntime(cfg, log, { busFlushIntervalMs: 0 });
  try {
    const before = await rt.parents.current();
    const next = await reinitialiseParent(rt, cfg, { txid: m[1]!, vout: Number(m[2]) });
    log.info('parent re-leased', {
      old: before ? `${before.txid}:${before.vout}` : null,
      new: `${next.txid}:${next.vout}`,
      valueSats: Number(next.value),
      confirmed: next.confirmed,
    });
  } finally {
    await rt.shutdown();
  }
}

main().catch((e) => {
  if (e instanceof ConfigError) log.error('configuration error', { problems: e.problems });
  else log.error('re-lease refused', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
