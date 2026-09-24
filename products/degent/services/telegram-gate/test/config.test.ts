import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, REGTEST_DEV_LINK_SECRET } from '../src/config.js';

const MAINNET = {
  NETWORK: 'mainnet',
  WEB_BASE_URL: 'https://degent.club/',
  HOLDERS_CHAT_ID: '-1001234567890',
  TELEGRAM_GATE_BOT_TOKEN: `123456789:${'A'.repeat(35)}`,
  MINT_API_URL: 'https://mint.degent.club',
  GATE_LINK_SECRET: 'k'.repeat(64),
  SESSION_KEY: 'ab'.repeat(32),
  DATABASE_PATH: '/var/lib/degent-telegram-gate/gate.db',
  ADMIN_ADDRESSES: 'bc1ppv609nr0vr25u07u95waq5lucwfm6tde4nydujnu8npg4q75mr5sxq8lt3',
};

const problems = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    return (e as ConfigError).problems;
  }
};

describe('loadConfig', () => {
  it('accepts a complete mainnet environment and derives the SIWB domain from WEB_BASE_URL', () => {
    const c = loadConfig(MAINNET);
    expect(c.settings).toMatchObject({ network: 'mainnet', webBaseUrl: 'https://degent.club', siwbDomain: 'degent.club', siwbUri: 'https://degent.club', holdersChatId: '-1001234567890' });
    expect(c.settings.adminAddresses).toHaveLength(1);
    expect(c.reverifyIntervalMs).toBe(6 * 3600 * 1000);
    expect(c.holderCacheMs).toBe(300_000);
    expect(c.port).toBe(8788);
  });

  it('regtest runs with in-memory adapters and dev secrets', () => {
    const c = loadConfig({ NETWORK: 'regtest', WEB_BASE_URL: 'http://localhost:5173', HOLDERS_CHAT_ID: '-100123' });
    expect(c).toMatchObject({ databasePath: null, botToken: null, mintApiUrl: null, sessionKey: null });
    expect(c.settings.linkSecret).toBe(REGTEST_DEV_LINK_SECRET);
    expect(c.settings.siwbDomain).toBe('localhost:5173');
  });

  it.each(['TELEGRAM_GATE_BOT_TOKEN', 'MINT_API_URL', 'GATE_LINK_SECRET', 'SESSION_KEY', 'DATABASE_PATH', 'HOLDERS_CHAT_ID', 'WEB_BASE_URL'])(
    'mainnet refuses a missing %s',
    (k) => {
      expect(problems({ ...MAINNET, [k]: undefined }).join('\n')).toContain(k);
    },
  );

  it('refuses weak or dev link secrets and malformed keys, lists every problem at once', () => {
    const p = problems({ ...MAINNET, GATE_LINK_SECRET: 'change-me', SESSION_KEY: 'zz', HOLDERS_CHAT_ID: 'group', TELEGRAM_GATE_BOT_TOKEN: 'nope' });
    expect(p).toHaveLength(4);
    expect(problems({ ...MAINNET, GATE_LINK_SECRET: REGTEST_DEV_LINK_SECRET }).join()).toMatch(/regtest dev secret/);
  });

  it('refuses http on mainnet, a SIWB domain other than the page host, and foreign admin addresses', () => {
    expect(problems({ ...MAINNET, WEB_BASE_URL: 'http://degent.club' }).join()).toMatch(/https/);
    expect(problems({ ...MAINNET, SIWB_DOMAIN: 'evil.example' }).join()).toMatch(/SIWB_DOMAIN/);
    expect(problems({ ...MAINNET, ADMIN_ADDRESSES: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }).join()).toMatch(/ADMIN_ADDRESSES/);
  });

  it('requires a known NETWORK', () => {
    expect(problems({ ...MAINNET, NETWORK: undefined }).join()).toMatch(/NETWORK is required/);
    expect(problems({ ...MAINNET, NETWORK: 'litecoin' }).join()).toMatch(/NETWORK must be/);
  });

  it('bounds the numeric settings', () => {
    expect(problems({ ...MAINNET, REVERIFY_INTERVAL_SECONDS: '5' }).join()).toMatch(/REVERIFY_INTERVAL_SECONDS/);
    expect(loadConfig({ ...MAINNET, REVERIFY_INTERVAL_SECONDS: '3600' }).reverifyIntervalMs).toBe(3_600_000);
  });
});
