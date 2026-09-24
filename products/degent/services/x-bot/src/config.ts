/** Environment -> typed config (mirrors env.schema.json). Safe by default: review queue on, posting off. */
import type { PublisherSettings } from './application/publisher.js';

export interface XBotConfig {
  publisher: PublisherSettings;
  mintApiUrl: string;
  /** null => MemoryXClient (dry run: posts are recorded, never sent). */
  xAccessToken: string | null;
  milestoneEvery: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): XBotConfig {
  const problems: string[] = [];
  const str = (k: string) => env[k]?.trim() || null;
  const bool = (k: string, def: boolean): boolean => {
    const v = str(k);
    if (v === null) return def;
    if (v === 'true') return true;
    if (v === 'false') return false;
    problems.push(`${k} must be true or false`);
    return def;
  };
  const mintApiUrl = str('MINT_API_URL');
  if (!mintApiUrl) problems.push('MINT_API_URL is required (the Register: /v1/register/*, /v1/stats)');
  else if (!/^https?:\/\//.test(mintApiUrl)) problems.push('MINT_API_URL must be an absolute http(s) URL');
  const postingEnabled = bool('POSTING_ENABLED', false);
  const xAccessToken = str('X_ACCESS_TOKEN');
  if (postingEnabled && !xAccessToken) problems.push('POSTING_ENABLED=true needs X_ACCESS_TOKEN');
  const every = Number(str('MILESTONE_EVERY') ?? '100');
  if (!Number.isSafeInteger(every) || every < 1) problems.push('MILESTONE_EVERY must be a positive integer');
  if (problems.length) throw new ConfigError(problems);
  return {
    // Anything but the literal "false" keeps the review queue on.
    publisher: { reviewQueueEnabled: str('REVIEW_QUEUE_ENABLED') !== 'false', postingEnabled },
    mintApiUrl: mintApiUrl!.replace(/\/+$/, ''),
    xAccessToken,
    milestoneEvery: every,
  };
}
