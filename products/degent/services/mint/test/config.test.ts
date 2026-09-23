import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { p2tr } from '@scure/btc-signer';
import { networkParams } from '@bsh/inscription';
import { ConfigError, loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/wiring.js';
import { silentLogger } from '../src/application/logger.js';
import schema from '../env.schema.json' with { type: 'json' };

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

const key = new Uint8Array(32).fill(3);
const addr = (net: 'mainnet' | 'testnet') => p2tr(schnorr.getPublicKey(key), undefined, networkParams(net)).address!;
const dir = mkdtempSync(join(tmpdir(), 'degent-cfg-'));
const keyFile = join(dir, 'parent.key');
writeFileSync(keyFile, Buffer.from(key).toString('hex'));

const testnetEnv = {
  NETWORK: 'testnet',
  DATABASE_PATH: join(dir, 'mint.db'),
  CONTENT_DIR: join(dir, 'content'),
  ESPLORA_URL: 'https://mempool.space/testnet4/api',
  ORD_URL: 'https://ord-testnet.example',
  PARENT_INSCRIPTION_ID: `${'a'.repeat(64)}i0`,
  PARENT_KEY_FILE: keyFile,
  COLLECTION_ADDRESS: addr('testnet'),
  REVEAL_ENCRYPTION_KEY: '44'.repeat(32),
  CORS_ORIGINS: 'https://degent.club, https://staging.degent.club',
  SIWB_DOMAIN: 'degent.club',
  SESSION_KEY: '55'.repeat(32),
  ROSTER_FILE: 'data/roster.json',
};

describe('loadConfig', () => {
  it('requires NETWORK', () => {
    expect(problems({})).toContain('NETWORK is required: one of mainnet, testnet, signet, regtest');
  });

  it('regtest runs on dev defaults (in-memory, dev reveal key, random parent key)', () => {
    const c = loadConfig({ NETWORK: 'regtest' });
    expect(c.databasePath).toBeNull();
    expect(c.revealEncryptionKey).toBeNull();
    expect(c.corsOrigins).toEqual([]);
    expect(c.settings.collection.rescueAfterSeconds).toBe(21_600);
    expect(c.settings.approval).toEqual({ approvalQuorum: 3, declineQuorum: 3, reviewSlaSeconds: 14 * 86_400, gallerySize: 4112 });
    expect(c.settings.auth.domain).toBe('localhost:8787');
    expect(c.holderRegistry).toBe('memory');
  });

  it('member approval settings are configurable and validated', () => {
    const c = loadConfig({ ...testnetEnv, APPROVAL_QUORUM: '5', DECLINE_QUORUM: '2', REVIEW_SLA_SECONDS: '86400', HOLDER_REGISTRY: 'roster-chain' });
    expect(c.settings.approval).toMatchObject({ approvalQuorum: 5, declineQuorum: 2, reviewSlaSeconds: 86_400 });
    const p = problems({ ...testnetEnv, SIWB_DOMAIN: 'Degent.Club', SESSION_KEY: 'nope', HOLDER_REGISTRY: 'ord', REVIEW_SLA_SECONDS: '10' });
    expect(p.join('\n')).toMatch(/SIWB_DOMAIN/);
    expect(p.join('\n')).toMatch(/SESSION_KEY/);
    expect(p.join('\n')).toMatch(/HOLDER_REGISTRY/);
    expect(p.join('\n')).toMatch(/REVIEW_SLA_SECONDS/);
    expect(problems({ ...testnetEnv, NETWORK: 'mainnet', HOLDER_REGISTRY: 'memory' }).join('\n')).toContain('HOLDER_REGISTRY=memory is dev-only');
  });

  it('fails fast listing every missing variable off regtest', () => {
    const p = problems({ NETWORK: 'testnet' });
    for (const k of ['DATABASE_PATH', 'CONTENT_DIR', 'ESPLORA_URL', 'ORD_URL', 'PARENT_INSCRIPTION_ID', 'COLLECTION_ADDRESS', 'REVEAL_ENCRYPTION_KEY', 'PARENT_KEY_FILE', 'SIWB_DOMAIN', 'SESSION_KEY'])
      expect(p.join('\n')).toContain(k);
  });

  it('accepts a complete testnet config', () => {
    const c = loadConfig(testnetEnv);
    expect(c.corsOrigins).toEqual(['https://degent.club', 'https://staging.degent.club']);
    expect(c.settings.collection.parentInscriptionId).toBe(`${'a'.repeat(64)}i0`);
  });

  it('refuses mainnet with the in-memory dev signer', () => {
    const p = problems({ ...testnetEnv, NETWORK: 'mainnet', COLLECTION_ADDRESS: addr('mainnet'), LIBRE_RPC_URL: 'http://10.0.0.1:8332' });
    expect(p).toContain('refusing to start on mainnet with the in-memory dev policy signer (SIGNER=memory)');
    expect(p).toContain('PARENT_KEY_FILE is dev-only and not accepted on mainnet');
  });

  it('mainnet requires a block-lane broadcaster and a mainnet collection address', () => {
    const p = problems({ ...testnetEnv, NETWORK: 'mainnet' });
    expect(p.join('\n')).toContain('LIBRE_RPC_URL');
    expect(p.join('\n')).toContain('COLLECTION_ADDRESS must be a taproot address on mainnet');
  });

  it('validates formats', () => {
    const p = problems({ ...testnetEnv, REVEAL_ENCRYPTION_KEY: 'short', CORS_ORIGINS: 'https://degent.club/path', PORT: 'x', STANDARD_CONCURRENCY: '50', SERVICE_FEE_SATS_BLOCK: '100' });
    expect(p.join('\n')).toMatch(/REVEAL_ENCRYPTION_KEY/);
    expect(p.join('\n')).toMatch(/CORS_ORIGINS/);
    expect(p.join('\n')).toMatch(/PORT/);
    expect(p.join('\n')).toMatch(/STANDARD_CONCURRENCY/);
    expect(p.join('\n')).toMatch(/SERVICE_FEE_ADDRESS/);
  });

  it('env.schema.json documents every variable config.ts reads', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    const read = new Set([...src.matchAll(/(?:str|int|num|url|need)\('([A-Z_]+)'/g)].map((m) => m[1]!));
    expect([...read].filter((k) => !(k in schema.properties))).toEqual([]);
  });
});

describe('buildRuntime (composition root)', () => {
  it('wires real adapters for a testnet config', async () => {
    const rt = buildRuntime(loadConfig(testnetEnv), silentLogger);
    expect(rt.signer.collectionAddress()).toBe(addr('testnet'));
    const res = await rt.app.request('/v1/config');
    expect((await res.json()).network).toBe('testnet');
    const reg = await rt.app.request('/v1/register');
    expect((await reg.json()).count).toBe(4112);
    rt.close();
  });

  it('refuses a collection address that is not the signer key', () => {
    expect(() => buildRuntime(loadConfig({ ...testnetEnv, COLLECTION_ADDRESS: p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(9)), undefined, networkParams('testnet')).address! }), silentLogger)).toThrow(ConfigError);
  });

  it('regtest dev runtime boots in memory', async () => {
    const rt = buildRuntime(loadConfig({ NETWORK: 'regtest' }), silentLogger);
    const res = await rt.app.request('/v1/config');
    expect((await res.json()).collectionAddress).toMatch(/^bcrt1p/);
  });
});
