/**
 * MINT_MODE=readonly (docs/SERVER.md, contracts/openapi/degent-mint.yaml "Modes"): the site and the Register are
 * served, every order / vote / subscription / sign-in write answers 503 mint_not_open, no worker runs and no policy
 * signer or parent is needed, so mainnet can serve degent.club before the KMS signer exists. The mainnet guard for
 * full mode is unchanged.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ConfigError, loadConfig } from '../src/config.js';
import { READONLY_CLOSED_ROUTES } from '../src/app.js';
import { buildRuntime } from '../src/wiring.js';
import { silentLogger } from '../src/application/logger.js';
import { api, makeHarness } from './fakes/harness.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-mint.yaml'), 'utf8'));

const problems = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems;
  }
};

/** What compose.server.yaml gives mint-mainnet-readonly: no signer, parent, reveal key, session key or database. */
const mainnetReadonly = {
  NETWORK: 'mainnet',
  MINT_MODE: 'readonly',
  MINT_ROLE: 'api',
  ESPLORA_URL: 'https://mempool.space/api',
  ORD_URL: 'https://ordinals.com',
  ORD_PUBLIC_URL: 'https://ordinals.com',
  CORS_ORIGINS: 'https://degent.club',
  TRUST_PROXY: 'true',
  ROSTER_FILE: 'data/roster.json',
};

/** Every closed route with a concrete path (ids filled in). */
const CLOSED_REQUESTS: Array<[string, string]> = [
  ['POST', '/v1/orders'],
  ['PUT', '/v1/orders/dgt_x/content'],
  ['POST', '/v1/orders/dgt_x/reveal'],
  ['POST', '/v1/orders/dgt_x/subscriptions'],
  ['POST', '/v1/orders/dgt_x/votes'],
  ['POST', '/v1/auth/challenge'],
  ['POST', '/v1/auth/verify'],
  ['GET', '/v1/review'],
];

describe('MINT_MODE config', () => {
  it('defaults to full; rejects unknown values', () => {
    expect(loadConfig({ NETWORK: 'regtest' }).mode).toBe('full');
    expect(problems({ NETWORK: 'regtest', MINT_MODE: 'closed' })).toContain('MINT_MODE must be "full" or "readonly"');
  });

  it('mainnet starts read-only with no signer, parent, reveal key, session key or database', () => {
    const c = loadConfig(mainnetReadonly);
    expect(c.mode).toBe('readonly');
    expect(c.settings.network).toBe('mainnet');
    expect(c.parentKeyFile).toBeNull();
    expect(c.databasePath).toBeNull();
    expect(c.settings.collection.parentInscriptionId).toBeNull();
    // Mainnet without a block-lane broadcaster still withdraws the block tier.
    expect(c.settings.collection.tiers.map((t) => t.tier)).toEqual(['standard']);
  });

  it('keeps the mainnet guard for full mode exactly as before', () => {
    const p = problems({ ...mainnetReadonly, MINT_MODE: 'full' });
    expect(p).toContain('refusing to start on mainnet with the in-memory dev policy signer (SIGNER=memory)');
    expect(p).toContain('PARENT_INSCRIPTION_ID is required on mainnet');
    expect(p).toContain('COLLECTION_ADDRESS is required on mainnet');
    expect(p).toContain('REVEAL_ENCRYPTION_KEY is required on mainnet (dev default is regtest-only)');
    expect(p).toContain('SESSION_KEY is required on mainnet (dev default is regtest-only)');
    expect(problems({ ...mainnetReadonly, MINT_MODE: 'full', SIGNER: 'kms' })).toContain('SIGNER=kms is not implemented yet (see adapters/kms-policy-signer.ts)');
  });

  it('still refuses a dev parent key file on mainnet, and the worker role, in read-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'degent-ro-'));
    const keyFile = join(dir, 'k');
    writeFileSync(keyFile, '01'.repeat(32));
    expect(problems({ ...mainnetReadonly, PARENT_KEY_FILE: keyFile })).toContain('PARENT_KEY_FILE is dev-only and not accepted on mainnet');
    expect(problems({ ...mainnetReadonly, MINT_ROLE: 'worker' })).toContain('MINT_MODE=readonly runs no worker: use MINT_ROLE=api (or all)');
    expect(problems({ ...mainnetReadonly, HOLDER_REGISTRY: 'memory' })).toContain('HOLDER_REGISTRY=memory is dev-only and refused on mainnet');
  });

  it('BLOCK_TIER=off withdraws the block tier on any network (public signet)', () => {
    const c = loadConfig({ NETWORK: 'regtest', BLOCK_TIER: 'off' });
    expect(c.blockTierWithdrawn).toBe(true);
    expect(c.settings.collection.tiers.map((t) => t.tier)).toEqual(['standard']);
    expect(loadConfig({ NETWORK: 'regtest' }).settings.collection.tiers.map((t) => t.tier)).toEqual(['standard', 'block']);
    expect(problems({ NETWORK: 'regtest', BLOCK_TIER: 'maybe' })).toContain('BLOCK_TIER must be "auto" or "off"');
  });
});

describe('read-only runtime (composition root, mainnet)', () => {
  it('has no worker and no signer, serves reads and closes every write', async () => {
    const rt = buildRuntime(loadConfig(mainnetReadonly), silentLogger);
    expect(rt.worker).toBeNull();
    expect(rt.signer).toBeNull();
    const cfg = await (await rt.app.request('/v1/config')).json();
    expect(cfg.mode).toBe('readonly');
    expect(cfg.network).toBe('mainnet');
    expect(cfg.collectionAddress).toBe('');
    const queue = await rt.app.request('/v1/queue');
    expect(queue.status).toBe(200);
    const reg = await (await rt.app.request('/v1/register')).json();
    expect(reg.count).toBe(4112);
    for (const [method, path] of CLOSED_REQUESTS) {
      const res = await rt.app.request(path, { method, headers: { 'content-type': 'application/json', origin: 'https://degent.club' }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect((await res.json()).error.code).toBe('mint_not_open');
    }
    rt.close();
  });
});

describe('read-only HTTP surface (harness)', () => {
  it('health and config report the mode; health has no parent check', async () => {
    const h = makeHarness({ mode: 'readonly' });
    const health = await api(h, 'GET', '/v1/health');
    expect(health.body.mode).toBe('readonly');
    expect(health.body.status).toBe('ok');
    expect((await api(h, 'GET', '/v1/config')).body.mode).toBe('readonly');
    expect((await api(makeHarness(), 'GET', '/v1/config')).body.mode).toBe('full');
  });

  it.each(CLOSED_REQUESTS)('%s %s answers 503 mint_not_open with retry-after, before auth or body checks', async (method, path) => {
    const h = makeHarness({ mode: 'readonly' });
    const r = await api(h, method, path, method === 'PUT' ? { bytes: new Uint8Array(4) } : method === 'POST' ? { json: {} } : {});
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: { code: 'mint_not_open', message: expect.stringContaining('not open') } });
    expect(r.headers.get('retry-after')).toBe('86400');
  });

  it('public reads stay open', async () => {
    const h = makeHarness({ mode: 'readonly' });
    for (const path of ['/v1/health', '/v1/config', '/v1/fees', '/v1/queue', '/v1/register', '/v1/register/1', '/v1/explorer', '/v1/stats'])
      expect((await api(h, 'GET', path)).status, path).toBe(200);
    expect((await api(h, 'GET', '/v1/orders/dgt_missing')).status).toBe(404);
  });

  it('full mode is unaffected (writes reach validation)', async () => {
    const h = makeHarness();
    expect((await api(h, 'POST', '/v1/orders', { json: {} })).status).not.toBe(503);
  });
});

describe('contract: the closed routes are exactly the ones documenting MintNotOpen', () => {
  it('matches READONLY_CLOSED_ROUTES', () => {
    const documented: string[] = [];
    for (const [path, ops] of Object.entries(openapi.paths as Record<string, Record<string, { responses?: Record<string, { $ref?: string }> }>>))
      for (const [method, op] of Object.entries(ops))
        if (op.responses?.['503']?.$ref === '#/components/responses/MintNotOpen') documented.push(`${method.toUpperCase()} ${path}`);
    const impl = CLOSED_REQUESTS.map(([m, p]) => `${m} ${p.replace('dgt_x', '{id}')}`);
    expect(documented.sort()).toEqual(impl.sort());
    expect(READONLY_CLOSED_ROUTES).toHaveLength(CLOSED_REQUESTS.length);
    for (const [m, p] of CLOSED_REQUESTS) expect(READONLY_CLOSED_ROUTES.some((r) => r.method === m && r.path.test(p)), `${m} ${p}`).toBe(true);
    expect(openapi.components.schemas.MintMode.enum).toEqual(['full', 'readonly']);
  });
});
