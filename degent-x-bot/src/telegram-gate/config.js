// Configuration for the holders-only Telegram gate. Reuses the base config
// (database, redis, admin JWT) and adds the gate's own variables.

const base = require('../config');

const gateConfig = {
  ...base,
  gate: {
    botToken: process.env.TELEGRAM_GATE_BOT_TOKEN,
    holdersChatId: process.env.HOLDERS_CHAT_ID,
    webBaseUrl: (process.env.WEB_BASE_URL || '').replace(/\/+$/, ''),
    registerApiUrl: (process.env.REGISTER_API_URL || '').replace(/\/+$/, ''),
    jwtSecret: process.env.GATE_JWT_SECRET,
    port: parseInt(process.env.GATE_PORT || '3001', 10),
    linkTtlMs: 10 * 60 * 1000, // /verify link and challenge lifetime
    inviteTtlMs: 10 * 60 * 1000, // Telegram invite link lifetime
    reverifyEveryMs: 6 * 60 * 60 * 1000,
    holderCacheTtlMs: 5 * 60 * 1000,
    verifyRateLimit: { max: 3, windowMs: 10 * 60 * 1000 }, // /verify per Telegram user
  },
};

const GATE_PLACEHOLDERS = ['', 'change-me', 'change-me-to-a-random-secret'];

/**
 * Pure validation of the gate section. Returns { ok, errors }.
 */
function collectGateProblems(cfg) {
  const errors = [];
  const g = cfg.gate || {};
  if (!g.botToken) errors.push('TELEGRAM_GATE_BOT_TOKEN is missing');
  if (!g.holdersChatId) errors.push('HOLDERS_CHAT_ID is missing');
  if (!g.webBaseUrl) errors.push('WEB_BASE_URL is missing');
  else if (!/^https?:\/\//.test(g.webBaseUrl)) errors.push('WEB_BASE_URL must be an absolute http(s) URL');
  if (!g.registerApiUrl) errors.push('REGISTER_API_URL is missing');
  else if (!/^https?:\/\//.test(g.registerApiUrl)) errors.push('REGISTER_API_URL must be an absolute http(s) URL');
  if (GATE_PLACEHOLDERS.includes(g.jwtSecret ?? '')) errors.push('GATE_JWT_SECRET is missing or a placeholder');
  else if (g.jwtSecret.length < 32) errors.push('GATE_JWT_SECRET must be at least 32 characters');
  else if (g.jwtSecret === cfg.admin?.jwtSecret) errors.push('GATE_JWT_SECRET must differ from JWT_SECRET');
  return { ok: errors.length === 0, errors };
}

module.exports = gateConfig;
module.exports.collectGateProblems = collectGateProblems;
