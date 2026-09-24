import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const problems = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    return (e as ConfigError).problems;
  }
};

describe('loadConfig', () => {
  it('is safe by default: review queue on, posting off, dry-run X client', () => {
    expect(loadConfig({ MINT_API_URL: 'https://mint.degent.club/' })).toEqual({
      publisher: { reviewQueueEnabled: true, postingEnabled: false },
      mintApiUrl: 'https://mint.degent.club',
      xAccessToken: null,
      milestoneEvery: 100,
    });
  });

  it.each([['false', false], ['true', true], ['0', true], ['no', true], ['FALSE', true], ['', true]])(
    'REVIEW_QUEUE_ENABLED=%j -> review queue %s (only the literal "false" turns it off)',
    (v, want) => {
      expect(loadConfig({ MINT_API_URL: 'https://m', REVIEW_QUEUE_ENABLED: v }).publisher.reviewQueueEnabled).toBe(want);
    },
  );

  it('posting needs a token; MINT_API_URL is required; flags are strict', () => {
    expect(problems({ MINT_API_URL: 'https://m', POSTING_ENABLED: 'true' }).join()).toMatch(/X_ACCESS_TOKEN/);
    expect(problems({}).join()).toMatch(/MINT_API_URL/);
    expect(problems({ MINT_API_URL: 'ftp://m' }).join()).toMatch(/http/);
    expect(problems({ MINT_API_URL: 'https://m', POSTING_ENABLED: 'yes' }).join()).toMatch(/POSTING_ENABLED/);
    expect(problems({ MINT_API_URL: 'https://m', MILESTONE_EVERY: '0' }).join()).toMatch(/MILESTONE_EVERY/);
  });
});
