import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { keyFromSeed } from './fakes/keys.js';

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems;
  }
};

describe('loadConfig', () => {
  it('regtest defaults: buys disabled, no royalty, memory adapters, safety check on', () => {
    const c = loadConfig({ NETWORK: 'regtest' });
    expect(c.settings.buysEnabled).toBe(false);
    expect(c.settings.royaltyBps).toBe(0);
    expect(c.settings.utxoSafetyCheck).toBe(true);
    expect(c.databasePath).toBeNull();
    expect(c.membership).toBe('memory');
    expect(c.port).toBe(8788);
  });

  it('BUYS_ENABLED must be explicitly true to enable buys', () => {
    expect(loadConfig({ NETWORK: 'regtest', BUYS_ENABLED: 'true' }).settings.buysEnabled).toBe(true);
    expect(loadConfig({ NETWORK: 'regtest', BUYS_ENABLED: 'false' }).settings.buysEnabled).toBe(false);
    expect(problems({ NETWORK: 'regtest', BUYS_ENABLED: 'maybe' })).toContain('BUYS_ENABLED must be true or false');
  });

  it('ROYALTY_BPS > 0 needs a valid TREASURY_ADDRESS on the same network; bps capped at 5000', () => {
    expect(problems({ NETWORK: 'regtest', ROYALTY_BPS: '250' })).toContain('TREASURY_ADDRESS is required when ROYALTY_BPS > 0');
    expect(problems({ NETWORK: 'regtest', ROYALTY_BPS: '250', TREASURY_ADDRESS: keyFromSeed('t', 'mainnet').tr.address })).toContain('TREASURY_ADDRESS is not a valid regtest address');
    expect(problems({ NETWORK: 'regtest', ROYALTY_BPS: '5001' })[0]).toMatch(/ROYALTY_BPS/);
    const ok = loadConfig({ NETWORK: 'regtest', ROYALTY_BPS: '250', TREASURY_ADDRESS: keyFromSeed('t').tr.address });
    expect(ok.settings).toMatchObject({ royaltyBps: 250, treasuryAddress: keyFromSeed('t').tr.address });
  });

  it('refuses dev adapters off regtest and unsafe mainnet combinations', () => {
    const p = problems({ NETWORK: 'mainnet', MEMBERSHIP: 'memory' });
    expect(p).toContain('DATABASE_PATH is required unless NETWORK=regtest');
    expect(p).toContain('MEMBERSHIP=memory is only allowed on regtest');
    expect(problems({ NETWORK: 'mainnet', DATABASE_PATH: '/x', MINT_API_URL: 'https://mint.degent.club', BUYS_ENABLED: 'true', UTXO_SAFETY_CHECK: 'false' })).toContain(
      'UTXO_SAFETY_CHECK=false is refused on mainnet while BUYS_ENABLED=true',
    );
    expect(problems({ NETWORK: 'mainnet', DATABASE_PATH: '/x' })).toContain('MINT_API_URL is required when MEMBERSHIP=mint-register');
    expect(problems({ NETWORK: 'moon' })[0]).toMatch(/NETWORK/);
  });

  it('a complete mainnet config', () => {
    const c = loadConfig({ NETWORK: 'mainnet', DATABASE_PATH: '/var/lib/market.db', MINT_API_URL: 'https://mint.degent.club/', CORS_ORIGINS: 'https://degent.club, https://www.degent.club' });
    expect(c.membership).toBe('mint-register');
    expect(c.mintApiUrl).toBe('https://mint.degent.club');
    expect(c.corsOrigins).toEqual(['https://degent.club', 'https://www.degent.club']);
    expect(c.settings.explorerTxUrl).toBe('https://mempool.space/tx');
    expect(c.settings.auth.domain).toBe('market.degent.club');
  });
});

describe('env.schema.json', () => {
  it('documents exactly the variables config.ts reads', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const read = new Set([...src.matchAll(/(?:str|int|bool|url)\('([A-Z_]+)'/g)].map((m) => m[1]!));
    const schema = JSON.parse(readFileSync(new URL('../env.schema.json', import.meta.url), 'utf8')) as { properties: Record<string, unknown> };
    expect([...read].sort()).toEqual(Object.keys(schema.properties).sort());
  });
});
