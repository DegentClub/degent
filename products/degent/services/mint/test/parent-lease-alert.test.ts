/**
 * p5.2: parent lease changes are logged (`parent.lease.changed`); a VALUE change logs `parent.value.changed`
 * at error level and opens a circuit breaker the worker honours until an operator acknowledges it through
 * `POST /v1/admin/parent/ack` (@bsh/edge API key, scope mint:admin), validated against the OpenAPI contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { generateApiKey, InMemoryApiKeyStore } from '@bsh/edge';
import type { Order } from '@bsh/degent-mint-sdk';
import { createApp } from '../src/app.js';
import { StaticFees } from '../src/adapters/fees.js';
import { MemoryOrderStore } from '../src/adapters/memory-order-store.js';
import { StoreParentUtxoProvider } from '../src/adapters/store-parent-utxo.js';
import type { Logger } from '../src/application/logger.js';
import type { ParentUtxo } from '../src/ports/parent-utxo.js';
import type { MintConfig } from '../src/config.js';
import { reinitialiseParent, type Runtime } from '../src/wiring.js';
import { api, browserMintToPayment, fakeTxid, fundCommit, makeHarness, type Harness } from './fakes/harness.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-mint.yaml'), 'utf8'));
const schemas = openapi.components.schemas;

/** Minimal JSON-schema check for the subset the contract uses. */
function check(value: unknown, schema: Record<string, any>, path = '$'): string[] {
  if (schema.$ref) return check(value, schemas[schema.$ref.split('/').pop()], path);
  if (schema.allOf) return schema.allOf.flatMap((s: any) => check(value, { ...s, additionalProperties: true }, path));
  if (schema.oneOf) return schema.oneOf.some((s: any) => check(value, s, path).length === 0) ? [] : [`${path}: matches no oneOf branch`];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: ${actual} not ${types}`];
  const errs: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errs.push(`${path}: not ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${String(value)} not in enum`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
  if (actual === 'object') {
    const v = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: missing`);
    for (const [k, sub] of Object.entries(v)) {
      const ps = schema.properties?.[k];
      if (ps) errs.push(...check(sub, ps, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not in contract`);
    }
  }
  return errs;
}
const ackSchema = (status: number) =>
  openapi.paths['/v1/admin/parent/ack'].post.responses[String(status)].content?.['application/json']?.schema ?? schemas.Error;

function capturingLog() {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const at = (level: string) => (msg: string, fields: Record<string, unknown> = {}) => void lines.push({ level, msg, fields });
  const log: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
  return { log, lines, events: (name: string) => lines.filter((l) => l.msg === name) };
}

const utxo = (n: number, value: bigint, over: Partial<ParentUtxo> = {}): ParentUtxo => ({
  txid: fakeTxid(n),
  vout: 0,
  value,
  scriptHex: '5120' + '11'.repeat(32),
  confirmed: true,
  createdByLane: null,
  ...over,
});

describe('StoreParentUtxoProvider: lease-change alerting', () => {
  it('logs parent.lease.changed with old/new outpoint and value on initialise and advance', async () => {
    const { log, events } = capturingLog();
    const p = new StoreParentUtxoProvider(new MemoryOrderStore(), { log, now: () => new Date('2026-09-24T00:00:00Z') });
    await p.initialise(utxo(1, 10_000n));
    expect(events('parent.lease.changed')[0]!.fields).toMatchObject({
      event: 'parent.lease.changed',
      reason: 'initialise',
      old: null,
      new: { outpoint: `${fakeTxid(1)}:0`, valueSats: 10_000 },
    });
    await p.lease('ord_a');
    await p.advance('ord_a', utxo(2, 10_000n, { confirmed: false, createdByLane: 'standard' }));
    const adv = events('parent.lease.changed')[1]!;
    expect(adv.level).toBe('info');
    expect(adv.fields).toMatchObject({ reason: 'advance', old: { outpoint: `${fakeTxid(1)}:0`, valueSats: 10_000 }, new: { outpoint: `${fakeTxid(2)}:0`, valueSats: 10_000 } });
    // Same value: no value alert, the breaker stays closed.
    expect(events('parent.value.changed')).toHaveLength(0);
    expect(await p.valueAlert()).toBeNull();
    // An idempotent initialise (store already has a parent) changes nothing and logs nothing.
    await p.initialise(utxo(3, 10_000n));
    expect(events('parent.lease.changed')).toHaveLength(2);
  });

  it('a value change logs parent.value.changed at error level and opens a persisted alert', async () => {
    const { log, events } = capturingLog();
    const store = new MemoryOrderStore();
    const p = new StoreParentUtxoProvider(store, { log, now: () => new Date('2026-09-24T01:00:00Z') });
    await p.initialise(utxo(1, 10_000n));
    await p.initialise(utxo(2, 12_000n), { force: true });
    const e = events('parent.value.changed');
    expect(e).toHaveLength(1);
    expect(e[0]!.level).toBe('error');
    expect(e[0]!.fields).toMatchObject({ old: { valueSats: 10_000 }, new: { outpoint: `${fakeTxid(2)}:0`, valueSats: 12_000 } });
    const alert = {
      at: '2026-09-24T01:00:00.000Z',
      reason: 'initialise',
      previous: { outpoint: `${fakeTxid(1)}:0`, valueSats: 10_000 },
      current: { outpoint: `${fakeTxid(2)}:0`, valueSats: 12_000 },
    };
    expect(await p.valueAlert()).toEqual(alert);
    // Survives a restart (the alert lives in the parent meta row).
    expect(await new StoreParentUtxoProvider(store).valueAlert()).toEqual(alert);
    // Correcting the value keeps the ORIGINAL alert open (an operator must still look), tracking where the parent is now.
    await p.initialise(utxo(3, 10_000n), { force: true });
    expect(await p.valueAlert()).toEqual({ ...alert, current: { outpoint: `${fakeTxid(3)}:0`, valueSats: 10_000 } });
  });

  it('acknowledge: refuses a stale or wrong parent; closes the alert for the current one; idempotent', async () => {
    const p = new StoreParentUtxoProvider(new MemoryOrderStore());
    expect(await p.acknowledgeValueChange({ outpoint: `${fakeTxid(1)}:0`, valueSats: 10_000, by: 'ops', at: new Date() })).toMatchObject({ ok: false, reason: 'no_parent' });
    await p.initialise(utxo(1, 10_000n));
    await p.initialise(utxo(2, 12_000n), { force: true });
    expect(await p.acknowledgeValueChange({ outpoint: `${fakeTxid(1)}:0`, valueSats: 10_000, by: 'ops', at: new Date() })).toMatchObject({ ok: false, reason: 'parent_mismatch' });
    expect(await p.acknowledgeValueChange({ outpoint: `${fakeTxid(2)}:0`, valueSats: 10_000, by: 'ops', at: new Date() })).toMatchObject({ ok: false, reason: 'parent_mismatch' });
    expect(await p.valueAlert()).not.toBeNull();
    const ok = await p.acknowledgeValueChange({ outpoint: `${fakeTxid(2)}:0`, valueSats: 12_000, by: 'ops', at: new Date('2026-09-24T02:00:00Z'), note: 'CHG-1' });
    expect(ok).toMatchObject({ ok: true, acknowledged: { acknowledgedBy: 'ops', note: 'CHG-1', alert: { previous: { valueSats: 10_000 } } } });
    expect(await p.valueAlert()).toBeNull();
    expect((await p.lastAcknowledgement())?.acknowledgedAt).toBe('2026-09-24T02:00:00.000Z');
    expect(await p.acknowledgeValueChange({ outpoint: `${fakeTxid(2)}:0`, valueSats: 12_000, by: 'ops', at: new Date() })).toMatchObject({ ok: true, acknowledged: null });
  });
});

function adminApp(h: Harness, keys: InMemoryApiKeyStore) {
  return createApp({
    orders: h.orders,
    fees: new StaticFees({ standard: { slow: 1, normal: 2, fast: 5 }, block: { min: 1, recommended: 3 } }, () => h.clock.now()),
    chain: h.chain,
    parents: h.parents,
    clock: h.clock,
    corsOrigins: ['https://degent.club'],
    rateLimit: { windowMs: 60_000, max: 10_000 },
    clientIp: () => '127.0.0.1',
    admin: { keys, environment: 'test' },
  });
}

async function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request('/v1/admin/parent/ack', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe('worker circuit breaker + POST /v1/admin/parent/ack', () => {
  it('stops co-signing on a value change until an admin acknowledges; health reports it; contract-valid responses', async () => {
    const h = makeHarness();
    await h.ready;
    const keys = new InMemoryApiKeyStore();
    const admin = generateApiKey('test');
    keys.add({ id: 'ops-alice', hash: admin.hash, env: 'test', scopes: ['mint:admin'] });
    const reader = generateApiKey('test');
    keys.add({ id: 'reader', hash: reader.hash, env: 'test', scopes: ['mint:read'] });
    const app = adminApp(h, keys);

    // An operator mistakenly re-initialises the parent with another value, then corrects it.
    const scriptHex = h.collectionScriptHex;
    h.chain.addTx({ txid: fakeTxid(500), vin: [], vout: [{ value: 12_000n, scriptHex }], confirmed: true });
    h.chain.addTx({ txid: fakeTxid(501), vin: [], vout: [{ value: h.parentValue, scriptHex }], confirmed: true });
    await h.parents.initialise(utxo(500, 12_000n, { scriptHex }), { force: true });
    await h.parents.initialise(utxo(501, h.parentValue, { scriptHex }), { force: true });

    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    let o = (await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order;
    expect(o.status).toBe('queued'); // paid and queued, but the parent is not co-signed
    expect(h.broadcasters.standard.sent).toHaveLength(0);
    expect(await h.parents.leasedBy()).toBeNull();

    const health = await (await app.request('/v1/health')).json();
    expect(health.status).toBe('degraded');
    expect(health.checks.parentValue).toMatchObject({ ok: false, detail: expect.stringMatching(/was 10000 sats; now 10000 sats at .*POST \/v1\/admin\/parent\/ack/) });

    const current = { outpoint: `${fakeTxid(501)}:0`, valueSats: Number(h.parentValue) };
    const errs: string[] = [];
    // No key, wrong scope, browser origin: refused in the mint's error shape.
    const none = await post(app, current);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('unauthorized');
    errs.push(...check(none.body, ackSchema(401)));
    const scoped = await post(app, current, { authorization: `Bearer ${reader.key}` });
    expect(scoped.status).toBe(403);
    expect(scoped.body.error.code).toBe('forbidden');
    errs.push(...check(scoped.body, ackSchema(403)));
    const live = generateApiKey('live');
    keys.add({ id: 'live', hash: live.hash, env: 'live', scopes: ['mint:admin'] });
    expect((await post(app, current, { authorization: `Bearer ${live.key}` })).status).toBe(401); // wrong environment
    expect((await post(app, current, { authorization: `Bearer ${admin.key}`, origin: 'https://evil.example' })).status).toBe(403);
    // Validation and stale acknowledgements.
    const bad = await post(app, { outpoint: 'x', valueSats: -1 }, { authorization: `Bearer ${admin.key}` });
    expect(bad.status).toBe(422);
    errs.push(...check(bad.body, ackSchema(422)));
    const stale = await post(app, { outpoint: `${fakeTxid(500)}:0`, valueSats: 12_000 }, { 'x-api-key': admin.key });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current).toEqual(current);
    errs.push(...check(stale.body, ackSchema(409)));
    expect(await h.parents.valueAlert()).not.toBeNull();

    // The acknowledgement names the parent that is there now.
    const ack = await post(app, { ...current, note: 'CHG-42 corrected re-init' }, { authorization: `Bearer ${admin.key}` });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({
      circuit: 'closed',
      parent: current,
      acknowledged: { acknowledgedBy: 'ops-alice', note: 'CHG-42 corrected re-init', alert: { previous: { valueSats: 10_000 }, current } },
    });
    errs.push(...check(ack.body, ackSchema(200)));
    const again = await post(app, current, { authorization: `Bearer ${admin.key}` });
    expect(again.body).toEqual({ circuit: 'closed', parent: current, acknowledged: null });
    errs.push(...check(again.body, ackSchema(200)));
    expect(errs).toEqual([]);

    expect((await (await app.request('/v1/health')).json()).checks.parentValue).toBeUndefined();
    await h.worker.tick();
    o = (await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order;
    expect(o.status).toBe('revealed');
    expect(h.broadcasters.standard.sent).toHaveLength(1);
  });

  it('acknowledging does not relax the PARENT_VALUE_SATS check: a parent of another value still pauses reveals', async () => {
    const h = makeHarness();
    await h.ready;
    const scriptHex = h.collectionScriptHex;
    await h.parents.initialise(utxo(600, 12_000n, { scriptHex }), { force: true });
    await h.parents.acknowledgeValueChange({ outpoint: `${fakeTxid(600)}:0`, valueSats: 12_000, by: 'ops', at: h.clock.now() });
    expect(await h.parents.valueAlert()).toBeNull();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    expect(((await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order).status).toBe('queued');
    expect(h.broadcasters.standard.sent).toHaveLength(0);
  });

  it('reveals advancing the parent (same value) never trip the breaker', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { recipientSeed: 3 });
    const b = await browserMintToPayment(h, { recipientSeed: 4 });
    fundCommit(h, a);
    fundCommit(h, b);
    await h.worker.tick();
    expect(h.broadcasters.standard.sent).toHaveLength(2);
    expect(await h.parents.valueAlert()).toBeNull();
  });
});

describe('reinitialiseParent (the RUNBOOK re-lease one-off, src/reinit-parent.ts)', () => {
  const asRuntime = (h: Harness) => ({ orders: h.orders, chain: h.chain, signer: h.signer, parents: h.parents }) as unknown as Runtime;
  const cfgOf = (h: Harness) => ({ settings: h.settings }) as unknown as MintConfig;

  it('re-leases to a checked outpoint of the same value without tripping the breaker; refuses wrong value, wrong script, busy parent', async () => {
    const h = makeHarness();
    await h.ready;
    const scriptHex = h.collectionScriptHex;
    h.chain.addTx({ txid: fakeTxid(700), vin: [], vout: [{ value: h.parentValue, scriptHex }], confirmed: true });
    h.chain.addTx({ txid: fakeTxid(701), vin: [], vout: [{ value: 12_000n, scriptHex }], confirmed: true });
    h.chain.addTx({ txid: fakeTxid(702), vin: [], vout: [{ value: h.parentValue, scriptHex: '5120' + '22'.repeat(32) }], confirmed: true });

    await expect(reinitialiseParent(asRuntime(h), cfgOf(h), { txid: fakeTxid(701), vout: 0 })).rejects.toThrow(/value 12000 sats != PARENT_VALUE_SATS 10000/);
    await expect(reinitialiseParent(asRuntime(h), cfgOf(h), { txid: fakeTxid(702), vout: 0 })).rejects.toThrow(/not held by the collection key/);
    await expect(reinitialiseParent(asRuntime(h), cfgOf(h), { txid: fakeTxid(703), vout: 0 })).rejects.toThrow(/not found on chain/);
    const next = await reinitialiseParent(asRuntime(h), cfgOf(h), { txid: fakeTxid(700), vout: 0 });
    expect(next).toMatchObject({ txid: fakeTxid(700), vout: 0, value: h.parentValue });
    expect((await h.parents.current())?.txid).toBe(fakeTxid(700));
    expect(await h.parents.valueAlert()).toBeNull();

    // An order mid-reveal holds the lease: the re-lease is refused until the queue drains.
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    expect(((await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order).status).toBe('revealing');
    await expect(reinitialiseParent(asRuntime(h), cfgOf(h), { txid: fakeTxid(700), vout: 0 })).rejects.toThrow(/orders are revealing/);
  });
});
