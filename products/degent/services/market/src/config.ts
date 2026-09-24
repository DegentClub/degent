/**
 * Environment → typed config. Mirrors env.schema.json. Fails fast with every problem listed and refuses
 * unsafe combinations: dev adapters off regtest, a royalty without a treasury, buys on mainnet without
 * the UTXO safety check.
 */
import { MAX_ROYALTY_BPS, MIN_DUMMY_VALUE, type Network } from '@bsh/degent-market-sdk';
import type { MarketSettings } from './application/settings.js';
import { isAddress } from './domain/settlement/addresses.js';

export interface MarketConfig {
  settings: MarketSettings;
  port: number;
  host: string;
  /** null → in-memory store (regtest only). */
  databasePath: string | null;
  esploraUrl: string;
  ordUrl: string;
  membership: 'memory' | 'roster' | 'mint-register';
  mintApiUrl: string | null;
  rosterFile: string | null;
  parentInscriptionId: string | null;
  corsOrigins: string[];
  watcherIntervalMs: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const NETWORKS: Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];
const EXPLORERS: Record<Network, string> = {
  mainnet: 'https://mempool.space/tx',
  testnet: 'https://mempool.space/testnet4/tx',
  signet: 'https://mempool.space/signet/tx',
  regtest: 'http://127.0.0.1:3002/tx',
};
const ESPLORAS: Record<Network, string> = {
  mainnet: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet4/api',
  signet: 'https://mempool.space/signet/api',
  regtest: 'http://127.0.0.1:3002/api',
};

export function loadConfig(env: Record<string, string | undefined>, version = '0.1.0'): MarketConfig {
  const problems: string[] = [];
  const str = (k: string): string | null => {
    const v = env[k]?.trim();
    return v ? v : null;
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const v = str(k);
    if (v === null) return def;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(`${k} must be an integer in ${min}..${max}`);
      return def;
    }
    return n;
  };
  const bool = (k: string, def: boolean): boolean => {
    const v = str(k);
    if (v === null) return def;
    if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
    problems.push(`${k} must be true or false`);
    return def;
  };
  const url = (k: string, def: string | null): string | null => {
    const v = str(k) ?? def;
    if (v === null) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      return v.replace(/\/+$/, '');
    } catch {
      problems.push(`${k} must be an http(s) URL`);
      return def;
    }
  };

  const networkRaw = str('NETWORK');
  const network = (networkRaw ?? '') as Network;
  if (!NETWORKS.includes(network)) problems.push('NETWORK must be one of mainnet|testnet|signet|regtest');
  const net: Network = NETWORKS.includes(network) ? network : 'regtest';
  const regtest = net === 'regtest';

  const buysEnabled = bool('BUYS_ENABLED', false);
  const royaltyBps = int('ROYALTY_BPS', 0, 0, MAX_ROYALTY_BPS);
  const treasuryAddress = str('TREASURY_ADDRESS');
  if (royaltyBps > 0 && !treasuryAddress) problems.push('TREASURY_ADDRESS is required when ROYALTY_BPS > 0');
  if (treasuryAddress && !isAddress(treasuryAddress, net)) problems.push(`TREASURY_ADDRESS is not a valid ${net} address`);
  const priceMinSats = int('PRICE_MIN_SATS', 1000, 546, 2_100_000_000_000_000);
  const priceMaxSats = int('PRICE_MAX_SATS', 100 * 100_000_000, 546, 2_100_000_000_000_000);
  if (priceMinSats > priceMaxSats) problems.push('PRICE_MIN_SATS must not exceed PRICE_MAX_SATS');
  const utxoSafetyCheck = bool('UTXO_SAFETY_CHECK', true);
  if (buysEnabled && !utxoSafetyCheck && net === 'mainnet') problems.push('UTXO_SAFETY_CHECK=false is refused on mainnet while BUYS_ENABLED=true');

  const databasePath = str('DATABASE_PATH');
  if (!databasePath && !regtest) problems.push('DATABASE_PATH is required unless NETWORK=regtest');
  const membershipRaw = str('MEMBERSHIP') ?? (regtest ? 'memory' : 'mint-register');
  const membership = membershipRaw as MarketConfig['membership'];
  if (!['memory', 'roster', 'mint-register'].includes(membershipRaw)) problems.push('MEMBERSHIP must be memory|roster|mint-register');
  if (membership === 'memory' && !regtest) problems.push('MEMBERSHIP=memory is only allowed on regtest');
  const mintApiUrl = url('MINT_API_URL', null);
  if (membership === 'mint-register' && !mintApiUrl) problems.push('MINT_API_URL is required when MEMBERSHIP=mint-register');
  const rosterFile = str('ROSTER_FILE');
  if (membership === 'roster' && !rosterFile) problems.push('ROSTER_FILE is required when MEMBERSHIP=roster');
  const parentInscriptionId = str('PARENT_INSCRIPTION_ID');
  if (parentInscriptionId && !/^[0-9a-f]{64}i\d+$/.test(parentInscriptionId)) problems.push('PARENT_INSCRIPTION_ID must look like <txid>i<index>');

  const siwbDomain = str('SIWB_DOMAIN') ?? (regtest ? '127.0.0.1:8788' : 'market.degent.club');
  const cfg: MarketConfig = {
    settings: {
      network: net,
      version,
      buysEnabled,
      royaltyBps,
      treasuryAddress,
      priceMinSats,
      priceMaxSats,
      listingMaxDays: int('LISTING_MAX_DAYS', 30, 1, 365),
      dummyValueSats: int('DUMMY_VALUE_SATS', MIN_DUMMY_VALUE, MIN_DUMMY_VALUE, 1000),
      challengeTtlSeconds: int('CHALLENGE_TTL_SECONDS', 600, 30, 3600),
      buySessionTtlSeconds: int('BUY_SESSION_TTL_SECONDS', 600, 30, 3600),
      pendingTimeoutMs: int('PENDING_TIMEOUT_MS', 6 * 3600_000, 60_000, 7 * 86_400_000),
      utxoSafetyCheck,
      explorerTxUrl: url('EXPLORER_TX_URL', EXPLORERS[net]) ?? EXPLORERS[net],
      auth: { domain: siwbDomain, uri: url('SIWB_URI', regtest ? `http://${siwbDomain}` : null) },
    },
    port: int('PORT', 8788, 1, 65535),
    host: str('HOST') ?? '127.0.0.1',
    databasePath,
    esploraUrl: url('ESPLORA_URL', ESPLORAS[net]) ?? ESPLORAS[net],
    ordUrl: url('ORD_URL', 'https://ordinals.com') ?? 'https://ordinals.com',
    membership,
    mintApiUrl,
    rosterFile,
    parentInscriptionId,
    corsOrigins: (str('CORS_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    watcherIntervalMs: int('WATCHER_INTERVAL_MS', 60_000, 1_000, 3_600_000),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60, 1, 100_000),
    trustProxy: bool('TRUST_PROXY', false),
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
