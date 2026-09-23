/**
 * Environment -> fee server configuration. The variables are documented in ../env.schema.json.
 * Pure (takes the env object) so tests can exercise every branch.
 */
import type { FeeOracleOptions } from './oracle.js';
import { bitcoindSource, blockLaneSource } from './sources/bitcoind.js';
import { esploraSource } from './sources/esplora.js';
import { mempoolBlocksSource, mempoolRecommendedSource } from './sources/mempool.js';
import { staticSource } from './sources/static.js';
import { isNetwork, type FeeSource, type FetchLike, type Network, type Target } from './types.js';

export interface ServerConfig {
  network: Network;
  port: number;
  host: string;
  corsOrigins: '*' | string[];
  oracle: FeeOracleOptions;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid fee server configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

export function loadServerConfig(env: Env, deps: { fetch?: FetchLike } = {}): ServerConfig {
  const problems: string[] = [];
  const str = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const list = (k: string) => (str(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const num = (k: string, def: number, { min = 0, integer = false } = {}): number => {
    const raw = str(k);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
      problems.push(`${k} must be ${integer ? 'an integer' : 'a number'} >= ${min} (got "${raw}")`);
      return def;
    }
    return n;
  };
  const target = (k: string, def: Target): Target => {
    const n = num(k, def, { min: 1, integer: true });
    if (![1, 3, 6, 144].includes(n)) {
      problems.push(`${k} must be one of 1, 3, 6, 144 (got ${n})`);
      return def;
    }
    return n as Target;
  };

  const networkRaw = str('FEE_NETWORK') ?? 'mainnet';
  if (!isNetwork(networkRaw)) problems.push(`FEE_NETWORK must be mainnet|testnet|signet|regtest (got "${networkRaw}")`);
  const network: Network = isNetwork(networkRaw) ? networkRaw : 'mainnet';
  const f = deps.fetch ? { fetch: deps.fetch } : {};

  const sources: FeeSource[] = [];
  for (const baseUrl of list('MEMPOOL_URLS')) sources.push(mempoolRecommendedSource({ baseUrl, ...f }));
  for (const baseUrl of list('MEMPOOL_BLOCKS_URLS')) sources.push(mempoolBlocksSource({ baseUrl, ...f }));
  for (const baseUrl of list('ESPLORA_URLS')) sources.push(esploraSource({ baseUrl, ...f }));
  const rpcAuth = (prefix: string) => {
    const user = str(`${prefix}_USER`);
    const password = env[`${prefix}_PASSWORD`];
    return user !== undefined || password !== undefined ? { auth: { user: user ?? '', password: password ?? '' } } : {};
  };
  const bitcoindUrl = str('BITCOIND_RPC_URL');
  if (bitcoindUrl) sources.push(bitcoindSource({ url: bitcoindUrl, ...rpcAuth('BITCOIND_RPC'), ...f }));
  const libreUrl = str('LIBRE_RELAY_RPC_URL');
  if (libreUrl)
    sources.push(blockLaneSource({ url: libreUrl, target: num('BLOCK_LANE_TARGET', 1, { min: 1, integer: true }), ...rpcAuth('LIBRE_RELAY_RPC'), ...f }));
  const staticRate = str('STATIC_FEE_RATE');
  if (staticRate !== undefined) {
    const r = num('STATIC_FEE_RATE', 1, { min: 0.1 });
    sources.push(staticSource({ targets: { 1: r, 3: r, 6: r, 144: r } }));
  }
  if (sources.length === 0)
    problems.push('no fee sources: set at least one of MEMPOOL_URLS, MEMPOOL_BLOCKS_URLS, ESPLORA_URLS, BITCOIND_RPC_URL, STATIC_FEE_RATE');
  if (network === 'mainnet' && staticRate !== undefined) problems.push('STATIC_FEE_RATE is refused on mainnet');

  const cors = list('CORS_ORIGINS');
  const cfg: ServerConfig = {
    network,
    port: num('PORT', 8080, { min: 1, integer: true }),
    host: str('HOST') ?? '0.0.0.0',
    corsOrigins: cors.length === 0 || cors.includes('*') ? '*' : cors,
    oracle: {
      network,
      sources,
      ttlMs: num('FEE_CACHE_TTL_SECONDS', 30, { min: 1 }) * 1000,
      maxStaleMs: num('FEE_MAX_STALE_SECONDS', 600) * 1000,
      staleAfterMs: num('SOURCE_STALE_AFTER_SECONDS', 300, { min: 1 }) * 1000,
      timeoutMs: num('SOURCE_TIMEOUT_MS', 5000, { min: 100, integer: true }),
      config: {
        minRelayFeeRate: num('MIN_RELAY_FEE_RATE', 1, { min: 0.1 }),
        lane: {
          minFeeRate: num('BLOCK_LANE_MIN_FEE_RATE', 1, { min: 0.1 }),
          premium: num('BLOCK_LANE_PREMIUM', 1, { min: 1 }),
          maxFeeRate: num('BLOCK_LANE_MAX_FEE_RATE', 500, { min: 1 }),
          recommendedTarget: target('BLOCK_LANE_RECOMMENDED_TARGET', 1),
        },
        tiers: {
          fast: target('FEE_TARGET_FAST', 1),
          normal: target('FEE_TARGET_NORMAL', 3),
          slow: target('FEE_TARGET_SLOW', 144),
        },
      },
    },
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
