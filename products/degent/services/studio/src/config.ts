/**
 * Environment -> typed config. Mirrors env.schema.json. Fails fast with every problem listed, and
 * refuses unsafe combinations (mainnet without a persistent store, a session key or live API keys).
 */
import type { ApiKeyRecord } from '@bsh/edge';
import type { Network } from '@bsh/degent-mint-sdk';
import { DEGENT_RULES_CONFIG, MAX_UPLOAD_BYTES } from '@bsh/degent-mint-sdk';
import { MAX_TTL_SECONDS } from '@bsh/identity';
import type { StudioSettings } from './application/settings.js';

export interface StudioConfig {
  settings: StudioSettings;
  port: number;
  host: string;
  databasePath: string | null; // null => in-memory stores (regtest only)
  contentDir: string | null; // null => in-memory content (regtest only)
  sessionSigningKey: string | null; // hex; null => ephemeral (regtest only)
  sessionKid: string;
  sessionPreviousKeys: Array<{ kid: string; publicKeyHex: string }>;
  apiKeys: ApiKeyRecord[];
  apiKeyEnvironment: 'live' | 'test';
  visionReviewApiKey: string | null;
  visionReviewGuidelinesFile: string | null;
  /** Telegram Bot API token for artist notifications (ADR-0012); null = webhook notifications only. */
  telegramBotToken: string | null;
  corsOrigins: string[];
  trustedProxies: string[];
  rateLimitPerMinute: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const NETWORKS: Network[] = ['mainnet', 'testnet', 'signet', 'regtest'];
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const SCOPES = ['studio:review', 'studio:internal'];

export function loadConfig(env: Record<string, string | undefined>, version = '0.1.0'): StudioConfig {
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
  const list = (k: string): string[] =>
    (str(k) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const networkRaw = str('NETWORK');
  const network = NETWORKS.includes(networkRaw as Network) ? (networkRaw as Network) : null;
  if (!network) problems.push(`NETWORK is required: one of ${NETWORKS.join(', ')}`);
  const net: Network = network ?? 'regtest';
  const dev = net === 'regtest';
  const need = (k: string) => {
    const v = str(k);
    if (v === null && !dev) problems.push(`${k} is required on ${net}`);
    return v;
  };

  const port = int('PORT', 8790, 1, 65_535);
  const databasePath = need('DATABASE_PATH');
  const contentDir = need('CONTENT_DIR');

  const domain = need('SIWB_DOMAIN') ?? `localhost:${port}`;
  if (!DOMAIN_RE.test(domain)) problems.push('SIWB_DOMAIN must be a lower-case host[:port]');
  const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain);
  const uri = str('SIWB_URI') ?? `${loopback ? 'http' : 'https'}://${domain}`;
  try {
    const u = new URL(uri);
    if (u.host !== domain) problems.push('SIWB_URI host must equal SIWB_DOMAIN');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) problems.push('SIWB_URI must be https (http only for localhost)');
  } catch {
    problems.push('SIWB_URI must be a URL');
  }
  const siwbTtl = int('SIWB_TTL_SECONDS', 300, 1, MAX_TTL_SECONDS);
  const statement = str('SIWB_STATEMENT');
  if (statement && !/^[^\x00-\x1f\x7f]{1,280}$/u.test(statement)) problems.push('SIWB_STATEMENT must be one printable line (1-280 chars)');

  const sessionSigningKey = need('SESSION_SIGNING_KEY');
  if (sessionSigningKey && !/^[0-9a-fA-F]{64}$/.test(sessionSigningKey)) problems.push('SESSION_SIGNING_KEY must be 32 bytes of hex (64 characters)');
  const sessionKid = str('SESSION_KID') ?? 'degent-studio-1';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sessionKid)) problems.push('SESSION_KID must match [A-Za-z0-9._-]{1,64}');
  const sessionPreviousKeys: StudioConfig['sessionPreviousKeys'] = [];
  for (const entry of list('SESSION_PREVIOUS_KEYS')) {
    const m = /^([A-Za-z0-9._-]{1,64}):([0-9a-fA-F]{64})$/.exec(entry);
    if (!m) problems.push(`SESSION_PREVIOUS_KEYS entry "${entry}" must be <kid>:<public key hex>`);
    else sessionPreviousKeys.push({ kid: m[1]!, publicKeyHex: m[2]! });
  }
  const sessionTtl = int('SESSION_TTL_SECONDS', 86_400, 60, 30 * 86_400);
  const issuer = str('SESSION_ISSUER') ?? 'degent-studio';

  const apiKeyEnvironmentRaw = str('API_KEY_ENVIRONMENT') ?? (net === 'mainnet' ? 'live' : 'test');
  if (apiKeyEnvironmentRaw !== 'live' && apiKeyEnvironmentRaw !== 'test') problems.push('API_KEY_ENVIRONMENT must be live or test');
  const apiKeyEnvironment = apiKeyEnvironmentRaw === 'live' ? 'live' : 'test';
  const apiKeys: ApiKeyRecord[] = [];
  const apiKeysRaw = str('API_KEYS');
  if (apiKeysRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(apiKeysRaw);
    } catch {
      problems.push('API_KEYS must be a JSON array');
    }
    if (parsed !== undefined) {
      if (!Array.isArray(parsed)) problems.push('API_KEYS must be a JSON array');
      else
        parsed.forEach((k: unknown, i: number) => {
          const r = k as Record<string, unknown>;
          if (typeof r !== 'object' || r === null || typeof r.id !== 'string' || typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash))
            return problems.push(`API_KEYS[${i}] needs id and hash (sha256 hex of the key)`);
          const scopes = Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === 'string') : [];
          if (scopes.length === 0 || scopes.some((s) => !SCOPES.includes(s))) return problems.push(`API_KEYS[${i}].scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
          const envv = r.env ?? apiKeyEnvironment;
          if (envv !== 'live' && envv !== 'test') return problems.push(`API_KEYS[${i}].env must be live or test`);
          apiKeys.push({ id: r.id, hash: r.hash, env: envv, scopes, ...(typeof r.name === 'string' ? { name: r.name } : {}) });
        });
    }
  }
  if (net === 'mainnet' && apiKeys.some((k) => k.env !== 'live')) problems.push('mainnet accepts only live API keys');
  if (net === 'mainnet' && apiKeyEnvironment !== 'live') problems.push('API_KEY_ENVIRONMENT must be live on mainnet');

  const corsOrigins = list('CORS_ORIGINS');
  for (const o of corsOrigins) {
    try {
      if (new URL(o).origin !== o) throw new Error();
    } catch {
      problems.push(`CORS_ORIGINS entry "${o}" must be an exact origin like https://degent.club`);
    }
  }
  const trustedProxies = list('TRUSTED_PROXIES');
  for (const p of trustedProxies) if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(p)) problems.push(`TRUSTED_PROXIES entry "${p}" must be an IP or CIDR`);

  const publicBaseUrl = (str('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
  if (publicBaseUrl) {
    try {
      const u = new URL(publicBaseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    } catch {
      problems.push('PUBLIC_BASE_URL must be an http(s) URL');
    }
  }

  const visionReviewApiKey = str('VISION_REVIEW_API_KEY');
  const telegramBotToken = str('TELEGRAM_BOT_TOKEN');
  if (telegramBotToken && !/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/.test(telegramBotToken)) problems.push('TELEGRAM_BOT_TOKEN must look like <bot id>:<secret> (from @BotFather)');

  const out: StudioConfig = {
    settings: {
      network: net,
      version,
      rules: { ...structuredClone(DEGENT_RULES_CONFIG), network: net },
      maxUploadBytes: MAX_UPLOAD_BYTES,
      siwb: { domain, uri, ttlSeconds: siwbTtl, statement },
      session: { ttlSeconds: sessionTtl, issuer, audience: 'degent', scopes: ['artist'] },
      publicBaseUrl,
      visionReview: visionReviewApiKey ? 'claude' : 'none',
    },
    port,
    host: str('HOST') ?? '127.0.0.1',
    databasePath,
    contentDir,
    sessionSigningKey,
    sessionKid,
    sessionPreviousKeys,
    apiKeys,
    apiKeyEnvironment,
    visionReviewApiKey,
    visionReviewGuidelinesFile: str('VISION_REVIEW_GUIDELINES_FILE'),
    telegramBotToken,
    corsOrigins,
    trustedProxies,
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 60, 1, 100_000),
  };
  if (problems.length) throw new ConfigError(problems);
  return out;
}
