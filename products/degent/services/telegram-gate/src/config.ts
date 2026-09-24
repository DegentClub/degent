/**
 * Environment -> typed config. Mirrors env.schema.json. Lists every problem at once and refuses unsafe
 * combinations: the in-memory Telegram / holder adapters and dev secrets are regtest-only.
 */
import { isBitcoinNetwork, type BitcoinNetwork } from '@bsh/identity';
import { DEFAULT_SETTINGS, type GateSettings } from './application/gate-service.js';
import { isVerifiableAddress } from './domain/address.js';

export interface GateConfig {
  settings: GateSettings;
  port: number;
  host: string;
  /** null => in-memory stores (regtest only). */
  databasePath: string | null;
  /** null => in-memory Telegram adapter that only logs (regtest only). */
  botToken: string | null;
  /** null => in-memory holder registry (regtest only). */
  mintApiUrl: string | null;
  /** Ed25519 session signing key (hex); null => regtest dev key. */
  sessionKey: string | null;
  sessionKid: string;
  reverifyIntervalMs: number;
  holderCacheMs: number;
  rateLimitPerMinute: number;
  trustProxy: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const PLACEHOLDERS = new Set(['change-me', 'changeme', 'change-me-to-a-random-secret', 'secret', 'dev']);
/** Regtest-only link secret: never accepted elsewhere. */
export const REGTEST_DEV_LINK_SECRET = 'regtest-dev-link-secret-not-for-real-use-0000';

export function loadConfig(env: Record<string, string | undefined>): GateConfig {
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
  const url = (k: string): string | null => {
    const v = str(k);
    if (v === null) return null;
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      return v.replace(/\/+$/, '');
    } catch {
      problems.push(`${k} must be an absolute http(s) URL`);
      return null;
    }
  };

  const rawNet = str('NETWORK');
  let network: BitcoinNetwork = 'regtest';
  if (!rawNet) problems.push('NETWORK is required (mainnet | testnet | signet | regtest)');
  else if (!isBitcoinNetwork(rawNet)) problems.push(`NETWORK must be mainnet | testnet | signet | regtest, got ${rawNet}`);
  else network = rawNet;
  const dev = network === 'regtest';
  const net = network;

  const webBaseUrl = url('WEB_BASE_URL');
  if (!webBaseUrl && !str('WEB_BASE_URL')) problems.push('WEB_BASE_URL is required (the site that serves /verify)');
  let siwbDomain = str('SIWB_DOMAIN');
  let siwbUri = webBaseUrl ?? 'http://localhost';
  if (webBaseUrl) {
    const u = new URL(webBaseUrl);
    if (!dev && u.protocol !== 'https:') problems.push(`WEB_BASE_URL must be https on ${net}`);
    siwbDomain ??= u.host;
    if (siwbDomain !== u.host) problems.push('SIWB_DOMAIN must equal the host of WEB_BASE_URL (the page the wallet signs on)');
    siwbUri = u.origin;
  }

  const holdersChatId = str('HOLDERS_CHAT_ID');
  if (!holdersChatId) problems.push('HOLDERS_CHAT_ID is required (the private group id, e.g. -1001234567890)');
  else if (!/^-?\d{5,20}$/.test(holdersChatId)) problems.push('HOLDERS_CHAT_ID must be a numeric chat id (e.g. -1001234567890)');

  const botToken = str('TELEGRAM_GATE_BOT_TOKEN');
  if (botToken && !/^\d{5,16}:[A-Za-z0-9_-]{30,}$/.test(botToken)) problems.push('TELEGRAM_GATE_BOT_TOKEN does not look like a BotFather token');
  if (!botToken && !dev) problems.push(`TELEGRAM_GATE_BOT_TOKEN is required on ${net}`);

  const mintApiUrl = url('MINT_API_URL');
  if (!mintApiUrl && !str('MINT_API_URL') && !dev) problems.push(`MINT_API_URL is required on ${net} (the Register: GET /v1/register/holder/{address})`);

  let linkSecret = str('GATE_LINK_SECRET');
  if (linkSecret && (PLACEHOLDERS.has(linkSecret.toLowerCase()) || linkSecret.length < 32)) problems.push('GATE_LINK_SECRET must be at least 32 characters and not a placeholder');
  if (!linkSecret && !dev) problems.push(`GATE_LINK_SECRET is required on ${net}`);
  if (linkSecret === REGTEST_DEV_LINK_SECRET && !dev) problems.push('GATE_LINK_SECRET is the regtest dev secret');
  linkSecret ??= REGTEST_DEV_LINK_SECRET;

  const sessionKey = str('SESSION_KEY');
  if (sessionKey && !/^[0-9a-fA-F]{64}$/.test(sessionKey)) problems.push('SESSION_KEY must be 32 bytes of hex (64 characters)');
  if (!sessionKey && !dev) problems.push(`SESSION_KEY is required on ${net}`);

  const adminAddresses = (str('ADMIN_ADDRESSES') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  for (const a of adminAddresses) if (!isVerifiableAddress(a, network)) problems.push(`ADMIN_ADDRESSES: ${a} is not a ${net} address`);

  const databasePath = str('DATABASE_PATH');
  if (!databasePath && !dev) problems.push(`DATABASE_PATH is required on ${net}`);

  const cfg: GateConfig = {
    settings: {
      network,
      holdersChatId: holdersChatId ?? '',
      webBaseUrl: webBaseUrl ?? '',
      siwbDomain: siwbDomain ?? 'localhost',
      siwbUri,
      linkSecret,
      linkTtlSeconds: DEFAULT_SETTINGS.linkTtlSeconds,
      inviteTtlSeconds: DEFAULT_SETTINGS.inviteTtlSeconds,
      verifyRateLimit: { ...DEFAULT_SETTINGS.verifyRateLimit },
      adminAddresses,
      sessionTtlSeconds: int('SESSION_TTL_SECONDS', DEFAULT_SETTINGS.sessionTtlSeconds, 60, 86_400),
    },
    port: int('PORT', 8788, 1, 65_535),
    host: str('HOST') ?? '127.0.0.1',
    databasePath,
    botToken,
    mintApiUrl,
    sessionKey,
    sessionKid: str('SESSION_KID') ?? 'gate-1',
    reverifyIntervalMs: int('REVERIFY_INTERVAL_SECONDS', 6 * 3600, 60, 7 * 86_400) * 1000,
    holderCacheMs: int('HOLDER_CACHE_SECONDS', 300, 0, 3600) * 1000,
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 30, 1, 10_000),
    trustProxy: str('TRUST_PROXY') === 'true',
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
