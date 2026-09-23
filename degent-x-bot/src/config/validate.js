// Startup configuration validation.
//
// The bot ships with placeholder values for the admin JWT secret, admin
// password and local database/redis URLs so that `npm run dev` works out of
// the box. Those placeholders must never reach production. This module checks
// the resolved config and refuses to start when a secret is missing or still
// set to a known default.
//
// Behaviour by environment:
//   production  -> throw on any violation
//   test        -> throw unless ALLOW_INSECURE_DEFAULTS=true is set explicitly
//   development -> log a warning, continue

const INSECURE_DEFAULTS = {
  JWT_SECRET: ['change-me-to-a-random-secret', 'change-me', 'secret', ''],
  ADMIN_PASSWORD: ['change-me', 'admin', 'password', ''],
};

const DEFAULT_DATABASE_URL = 'postgresql://dgentx:dgentx@localhost:5432/dgentx';
const MIN_JWT_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

function isTruthyFlag(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

/**
 * Validate a config object. Pure: does not throw, does not log.
 * @param {object} config - the resolved config from ./index.js
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function collectConfigProblems(config) {
  const errors = [];
  const warnings = [];

  const jwtSecret = config.admin?.jwtSecret ?? '';
  if (INSECURE_DEFAULTS.JWT_SECRET.includes(jwtSecret)) {
    errors.push('JWT_SECRET is missing or set to a placeholder value');
  } else if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }

  const adminPassword = config.admin?.password ?? '';
  if (INSECURE_DEFAULTS.ADMIN_PASSWORD.includes(adminPassword)) {
    errors.push('ADMIN_PASSWORD is missing or set to a placeholder value');
  } else if (adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    errors.push(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }

  if (!config.databaseUrl) {
    errors.push('DATABASE_URL is missing');
  } else if (config.databaseUrl === DEFAULT_DATABASE_URL) {
    errors.push('DATABASE_URL is the built-in default (dgentx:dgentx@localhost) — set a real password');
  }

  if (!config.redisUrl) {
    errors.push('REDIS_URL is missing');
  } else {
    try {
      const url = new URL(config.redisUrl);
      if (!url.password && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        warnings.push('REDIS_URL has no password; Redis must not be reachable from outside the compose network');
      }
    } catch (_) {
      errors.push('REDIS_URL is not a valid URL');
    }
  }

  const tw = config.twitter || {};
  const missingTwitter = ['apiKey', 'apiSecret', 'accessToken', 'accessTokenSecret']
    .filter((k) => !tw[k] || /^your_/.test(tw[k]));
  if (missingTwitter.length > 0) {
    warnings.push(`X API credentials incomplete (${missingTwitter.join(', ')}); posting will fail`);
  }

  const ai = config.ai || {};
  if (!ai.anthropicApiKey && !ai.openaiApiKey && !ai.openrouterKey) {
    warnings.push('No AI provider key configured (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_KEY)');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Enforce validation according to the environment.
 * Throws an Error whose message lists every problem when the environment
 * demands it.
 *
 * @param {object} config
 * @param {object} [opts]
 * @param {string} [opts.nodeEnv]   defaults to config.nodeEnv
 * @param {object} [opts.env]       process.env substitute (for tests)
 * @param {object} [opts.logger]    pino-like logger
 */
function validateConfig(config, opts = {}) {
  const nodeEnv = opts.nodeEnv || config.nodeEnv || 'development';
  const env = opts.env || process.env;
  const log = opts.logger || console;

  const result = collectConfigProblems(config);

  for (const w of result.warnings) {
    log.warn({ nodeEnv }, `config: ${w}`);
  }

  if (result.ok) return result;

  const override = isTruthyFlag(env.ALLOW_INSECURE_DEFAULTS);
  const strict = nodeEnv === 'production' || (nodeEnv === 'test' && !override);

  const summary = `Insecure or missing configuration:\n  - ${result.errors.join('\n  - ')}`;

  if (strict) {
    const err = new Error(`${summary}\nRefusing to start in NODE_ENV=${nodeEnv}.`);
    err.code = 'E_INSECURE_CONFIG';
    err.problems = result.errors;
    throw err;
  }

  log.warn({ nodeEnv, problems: result.errors }, 'config: running with insecure defaults (allowed outside production)');
  return result;
}

module.exports = {
  validateConfig,
  collectConfigProblems,
  INSECURE_DEFAULTS,
  DEFAULT_DATABASE_URL,
  MIN_JWT_SECRET_LENGTH,
  MIN_ADMIN_PASSWORD_LENGTH,
};
