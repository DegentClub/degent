/**
 * Environment -> typed config. Mirrors env.schema.json. Every problem is listed at once; the process
 * refuses to start on any. Without a provider key the service runs in `fake` mode and says so in
 * /v1/health (deliberate: demo and CI never need a key).
 */
export type ProviderMode = 'fake' | 'openai' | 'http';

export interface AtelierConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  mode: ProviderMode;
  openai: { apiKey: string; model: string; fallbackModel: string | null; quality: 'low' | 'medium' | 'high'; costCentsPerImage: number | null } | null;
  http: { url: string; apiKey: string | null; style: 'stability' | 'replicate' | 'generic'; authHeader: string; authScheme: 'bearer' | 'raw'; costCentsPerImage: number } | null;
  visionReviewApiKey: string | null;
  databasePath: string | null;
  contentDir: string | null;
  corsOrigins: string[];
  trustedProxies: string[];
  rateLimitPerMinute: number;
  sessionRateLimitPerMinute: number;
  quotas: { sessionDailyImages: number; globalDailyCostCents: number; sessionsPerIpPerDay: number; sessionTtlHours: number };
  workerIntervalMs: number;
  workerConcurrency: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): AtelierConfig {
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
  const oneOf = <T extends string>(k: string, values: readonly T[], def: T): T => {
    const v = str(k);
    if (v === null) return def;
    if (!(values as readonly string[]).includes(v)) {
      problems.push(`${k} must be one of ${values.join(', ')}`);
      return def;
    }
    return v as T;
  };
  const list = (k: string): string[] =>
    (str(k) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const openaiKey = str('OPENAI_API_KEY');
  const httpUrl = str('HTTP_PROVIDER_URL');
  const defaultMode: ProviderMode = openaiKey ? 'openai' : httpUrl ? 'http' : 'fake';
  const mode = oneOf('ATELIER_MODE', ['fake', 'openai', 'http'] as const, defaultMode);
  if (mode === 'openai' && !openaiKey) problems.push('ATELIER_MODE=openai needs OPENAI_API_KEY');
  if (mode === 'http' && !httpUrl) problems.push('ATELIER_MODE=http needs HTTP_PROVIDER_URL');
  for (const k of ['HTTP_PROVIDER_URL', 'PUBLIC_BASE_URL']) {
    const v = str(k);
    if (v !== null) {
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      } catch {
        problems.push(`${k} must be an http(s) URL`);
      }
    }
  }
  for (const o of list('CORS_ORIGINS')) {
    try {
      if (new URL(o).origin !== o) throw new Error();
    } catch {
      problems.push(`CORS_ORIGINS entry ${JSON.stringify(o)} is not an exact origin`);
    }
  }
  const costOverride = str('PROVIDER_COST_CENTS_PER_IMAGE');
  const cost = costOverride === null ? null : int('PROVIDER_COST_CENTS_PER_IMAGE', 4, 0, 10_000);
  const quality = oneOf('OPENAI_IMAGE_QUALITY', ['low', 'medium', 'high'] as const, 'medium');
  const fallback = str('OPENAI_FALLBACK_MODEL');

  const cfg: AtelierConfig = {
    port: int('PORT', 8788, 1, 65535),
    host: str('HOST') ?? '127.0.0.1',
    publicBaseUrl: (str('PUBLIC_BASE_URL') ?? '').replace(/\/$/, ''),
    mode,
    openai: mode === 'openai' && openaiKey ? { apiKey: openaiKey, model: str('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1', fallbackModel: fallback === 'none' ? null : (fallback ?? 'dall-e-3'), quality, costCentsPerImage: cost } : null,
    http:
      mode === 'http' && httpUrl
        ? {
            url: httpUrl,
            apiKey: str('HTTP_PROVIDER_API_KEY'),
            style: oneOf('HTTP_PROVIDER_STYLE', ['stability', 'replicate', 'generic'] as const, 'generic'),
            authHeader: str('HTTP_PROVIDER_AUTH_HEADER') ?? 'authorization',
            authScheme: oneOf('HTTP_PROVIDER_AUTH_SCHEME', ['bearer', 'raw'] as const, 'bearer'),
            costCentsPerImage: cost ?? 4,
          }
        : null,
    visionReviewApiKey: str('VISION_REVIEW_API_KEY'),
    databasePath: str('DATABASE_PATH'),
    contentDir: str('CONTENT_DIR'),
    corsOrigins: list('CORS_ORIGINS'),
    trustedProxies: list('TRUSTED_PROXIES'),
    rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 120, 1, 100_000),
    sessionRateLimitPerMinute: int('SESSION_RATE_LIMIT_PER_MINUTE', 30, 1, 100_000),
    quotas: {
      sessionDailyImages: int('SESSION_DAILY_IMAGES', 8, 0, 10_000),
      globalDailyCostCents: int('GLOBAL_DAILY_COST_CENTS', 2000, 0, 100_000_000),
      sessionsPerIpPerDay: int('SESSIONS_PER_IP_PER_DAY', 20, 1, 100_000),
      sessionTtlHours: int('SESSION_TTL_HOURS', 24, 1, 24 * 30),
    },
    workerIntervalMs: int('WORKER_INTERVAL_MS', 1000, 50, 600_000),
    workerConcurrency: int('WORKER_CONCURRENCY', 2, 1, 16),
  };
  if ((cfg.databasePath === null) !== (cfg.contentDir === null)) problems.push('set both DATABASE_PATH and CONTENT_DIR, or neither (in-memory demo mode)');
  if (mode !== 'fake' && cfg.databasePath === null) problems.push('a live provider needs DATABASE_PATH and CONTENT_DIR so the cost ledger survives restarts');
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
