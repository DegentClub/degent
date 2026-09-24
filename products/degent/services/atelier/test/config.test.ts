import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { buildProvider } from '../src/wiring.js';

describe('config', () => {
  it('boots in fake mode with in-memory stores when no provider key is set', () => {
    const c = loadConfig({});
    expect(c.mode).toBe('fake');
    expect(c.openai).toBeNull();
    expect(c.databasePath).toBeNull();
    expect(buildProvider(c).name).toBe('fake');
    expect(c.quotas).toEqual({ sessionDailyImages: 8, globalDailyCostCents: 2000, sessionsPerIpPerDay: 20, sessionTtlHours: 24 });
  });

  it('selects OpenAI when a key is present (gpt-image-1 with dall-e-3 fallback) and requires durable stores', () => {
    expect(() => loadConfig({ OPENAI_API_KEY: 'sk-x' })).toThrow(/needs DATABASE_PATH and CONTENT_DIR/);
    const c = loadConfig({ OPENAI_API_KEY: 'sk-x', DATABASE_PATH: '/tmp/a.db', CONTENT_DIR: '/tmp/c' });
    expect(c.mode).toBe('openai');
    expect(c.openai).toMatchObject({ model: 'gpt-image-1', fallbackModel: 'dall-e-3', quality: 'medium' });
    expect(buildProvider(c).name).toBe('openai:gpt-image-1');
    expect(loadConfig({ OPENAI_API_KEY: 'sk-x', OPENAI_FALLBACK_MODEL: 'none', DATABASE_PATH: '/a', CONTENT_DIR: '/c' }).openai!.fallbackModel).toBeNull();
  });

  it('forcing fake mode ignores a configured key (demo deployments)', () => {
    expect(loadConfig({ ATELIER_MODE: 'fake', OPENAI_API_KEY: 'sk-x' }).mode).toBe('fake');
  });

  it('lists every problem at once and never echoes secret values', () => {
    try {
      loadConfig({ ATELIER_MODE: 'http', HTTP_PROVIDER_API_KEY: 'sk-supersecret', PORT: '99999', CORS_ORIGINS: 'https://ok.example,https://bad.example/path', SESSION_DAILY_IMAGES: '-1', DATABASE_PATH: '/x.db' });
      throw new Error('expected ConfigError');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const p = (e as ConfigError).problems;
      expect(p).toEqual(
        expect.arrayContaining([
          'ATELIER_MODE=http needs HTTP_PROVIDER_URL',
          'PORT must be an integer in 1..65535',
          'CORS_ORIGINS entry "https://bad.example/path" is not an exact origin',
          'SESSION_DAILY_IMAGES must be an integer in 0..10000',
          'set both DATABASE_PATH and CONTENT_DIR, or neither (in-memory demo mode)',
        ]),
      );
      expect(JSON.stringify(p)).not.toContain('supersecret');
    }
  });

  it('configures the generic HTTP provider', () => {
    const c = loadConfig({ HTTP_PROVIDER_URL: 'https://api.stability.example/v2', HTTP_PROVIDER_STYLE: 'stability', HTTP_PROVIDER_AUTH_HEADER: 'x-api-key', HTTP_PROVIDER_AUTH_SCHEME: 'raw', PROVIDER_COST_CENTS_PER_IMAGE: '3', DATABASE_PATH: '/a', CONTENT_DIR: '/c' });
    expect(c.mode).toBe('http');
    expect(c.http).toMatchObject({ style: 'stability', authHeader: 'x-api-key', authScheme: 'raw', costCentsPerImage: 3 });
    expect(buildProvider(c).name).toBe('http:stability');
  });
});
