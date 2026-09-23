// Runtime configuration. Everything comes from the environment so the same
// build runs on mainnet, testnet4 or signet without code changes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MEMPOOL_DEFAULTS = {
  mainnet: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
};

const MEMPOOL_WEB_DEFAULTS = {
  mainnet: 'https://mempool.space',
  testnet: 'https://mempool.space/testnet4',
  signet: 'https://mempool.space/signet',
};

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer in env: ${v}`);
  return Math.trunc(n);
}

export function loadConfig(env = process.env) {
  const network = (env.BITCOIN_NETWORK || 'mainnet').toLowerCase();
  if (!MEMPOOL_DEFAULTS[network]) {
    throw new Error(`BITCOIN_NETWORK must be mainnet|testnet|signet, got "${network}"`);
  }
  const indexer = (env.INDEXER || 'ord').toLowerCase();
  if (!['ord', 'hiro'].includes(indexer)) {
    throw new Error(`INDEXER must be ord|hiro, got "${indexer}"`);
  }

  const cfg = {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    port: int(env.PORT, 3000),
    buysEnabled: bool(env.BUYS_ENABLED, false),
    corsOrigin: env.CORS_ORIGIN || '',
    network,
    mempoolApi: env.MEMPOOL_API || MEMPOOL_DEFAULTS[network],
    mempoolWeb: env.MEMPOOL_WEB || MEMPOOL_WEB_DEFAULTS[network],
    indexer,
    ordApi: (env.ORD_API || 'https://ordinals.com').replace(/\/$/, ''),
    hiroApi: (env.HIRO_API || 'https://api.hiro.so').replace(/\/$/, ''),
    utxoSafetyCheck: bool(env.UTXO_SAFETY_CHECK, true),
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(ROOT, 'data', 'market.db'),
    royaltyBps: int(env.ROYALTY_BPS, 0),
    treasuryAddress: env.TREASURY_ADDRESS || '',
    priceMinSats: int(env.PRICE_MIN_SATS, 1000),
    priceMaxSats: int(env.PRICE_MAX_SATS, 100 * 1e8),
    listingMaxDays: int(env.LISTING_MAX_DAYS, 30),
    watcherIntervalMs: int(env.WATCHER_INTERVAL_MS, 60_000),
    pendingTimeoutMs: int(env.PENDING_TIMEOUT_MS, 6 * 60 * 60 * 1000),
    challengeTtlSec: int(env.CHALLENGE_TTL_SEC, 600),
    buySessionTtlSec: int(env.BUY_SESSION_TTL_SEC, 600),
    dummyValueSats: 600,
    postageMinSats: 546,
  };

  if (cfg.royaltyBps < 0 || cfg.royaltyBps > 5000) {
    throw new Error('ROYALTY_BPS must be between 0 and 5000');
  }
  if (cfg.buysEnabled && cfg.royaltyBps > 0 && !cfg.treasuryAddress) {
    throw new Error('TREASURY_ADDRESS is required when ROYALTY_BPS > 0 and BUYS_ENABLED=true');
  }
  return cfg;
}

// Subset that is safe to expose to the browser.
export function publicConfig(cfg) {
  return {
    buysEnabled: cfg.buysEnabled,
    network: cfg.network,
    mempoolWeb: cfg.mempoolWeb,
    royaltyBps: cfg.royaltyBps,
    priceMinSats: cfg.priceMinSats,
    priceMaxSats: cfg.priceMaxSats,
    listingMaxDays: cfg.listingMaxDays,
    dummyValueSats: cfg.dummyValueSats,
  };
}
