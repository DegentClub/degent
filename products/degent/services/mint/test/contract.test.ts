/**
 * Implementation <-> contract conformance: routes, error codes, required fields and live responses
 * checked against contracts/openapi/degent-mint.yaml and contracts/asyncapi/degent-mint.yaml, and the
 * degent.mint.order.{status} topic checked against the platform's canonical schema in
 * deps/scribbit/contracts/asyncapi/platform-events.yaml (ADR-0004: shared topics are owned by the platform).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ORDER_STATUSES } from '@bsh/degent-mint-sdk';
import { api, browserMintToPayment, fundCommit, makeHarness } from './fakes/harness.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-mint.yaml'), 'utf8'));
const asyncapi = parse(readFileSync(join(root, 'contracts/asyncapi/degent-mint.yaml'), 'utf8'));
const platformEvents = parse(readFileSync(join(root, 'deps/scribbit/contracts/asyncapi/platform-events.yaml'), 'utf8'));
const schemas = openapi.components.schemas;

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

/** Minimal JSON-schema check for the subset the contract uses (type/required/additionalProperties/$ref/enum/oneOf/allOf). */
function check(value: unknown, schema: Record<string, any>, path = '$'): string[] {
  if (schema.$ref) return check(value, schemas[schema.$ref.split('/').pop()], path);
  if (schema.allOf) return schema.allOf.flatMap((s: any) => check(value, { ...s, additionalProperties: true }, path));
  if (schema.oneOf) return schema.oneOf.some((s: any) => check(value, s, path).length === 0) ? [] : [`${path}: matches no oneOf branch`];
  const errs: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: ${actual} not ${types}`];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${String(value)} not in enum`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
  if (actual === 'object') {
    const v = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: missing`);
    for (const [k, sub] of Object.entries(v)) {
      const ps = schema.properties?.[k];
      if (ps) errs.push(...check(sub, ps, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not in contract`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...check(sub, schema.additionalProperties, `${path}.${k}`));
    }
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((x, i) => errs.push(...check(x, schema.items, `${path}[${i}]`)));
  return errs;
}

const responseSchema = (path: string, method: string, status: number) =>
  openapi.paths[path][method].responses[String(status)].content['application/json'].schema;

describe('OpenAPI contract', () => {
  it('every implemented route is in the contract and vice versa', () => {
    const h = makeHarness();
    const impl = new Set(
      h.app.routes
        .filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
    );
    const contract = new Set(
      Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops as object).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`)),
    );
    expect([...impl].sort()).toEqual([...contract].sort());
  });

  it('every error code the service can emit is in the ErrorCode enum', () => {
    const codes = new Set<string>();
    for (const f of srcFiles(new URL('../src', import.meta.url).pathname)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(?:DomainError\(|errorBody\()'([a-z_]+)'/g)) codes.add(m[1]!);
    }
    for (const c of ['not_found', 'conflict', 'validation_failed']) codes.add(c);
    expect([...codes].filter((c) => !schemas.ErrorCode.enum.includes(c))).toEqual([]);
  });

  it('OrderStatus enums agree across SDK, OpenAPI and AsyncAPI', () => {
    expect(schemas.OrderStatus.enum).toEqual([...ORDER_STATUSES]);
    expect(asyncapi.components.schemas.OrderStatus.enum).toEqual([...ORDER_STATUSES]);
    expect(asyncapi.channels.orderStatus.parameters.status.enum).toEqual([...ORDER_STATUSES]);
  });

  it('live responses validate against the contract schemas', async () => {
    const h = makeHarness();
    await h.ready;
    const errs: string[] = [];
    const expectOk = async (method: string, path: string, template: string, status: number, init = {}) => {
      const r = await api(h, method.toUpperCase(), path, init);
      expect(r.status).toBe(status);
      errs.push(...check(r.body, responseSchema(template, method, status), `${method} ${template}`));
      return r;
    };
    await expectOk('get', '/v1/health', '/v1/health', 200);
    await expectOk('get', '/v1/config', '/v1/config', 200);
    await expectOk('get', '/v1/fees', '/v1/fees', 200);
    await expectOk('get', '/v1/queue', '/v1/queue', 200);
    const b = await browserMintToPayment(h);
    await expectOk('get', `/v1/orders/${b.orderId}`, '/v1/orders/{id}', 200);
    fundCommit(h, b);
    await h.worker.tick();
    await expectOk('get', `/v1/orders/${b.orderId}`, '/v1/orders/{id}', 200);
    const e = await api(h, 'GET', `/v1/orders/${b.orderId}/rescue`, { token: b.token });
    errs.push(...check(e.body, schemas.Error));
    h.clock.advance(7 * 3600);
    // one more order to reach rescue_available
    const c = await browserMintToPayment(h, { recipientSeed: 3 });
    fundCommit(h, c);
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    h.clock.advance(7 * 3600);
    await h.worker.tick();
    await expectOk('get', `/v1/orders/${c.orderId}/rescue`, '/v1/orders/{id}/rescue', 200, { token: c.token });
    expect(errs).toEqual([]);
  });

  it('create/upload/reveal responses validate', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    const errs = check(b.order, schemas.Order);
    expect(errs).toEqual([]);
  });
});

describe('AsyncAPI contract', () => {
  it('every emitted event validates against OrderStatusEvent', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    // AsyncAPI's only local ref is OrderStatus, identical to OpenAPI's (asserted above), so the
    // OpenAPI schema map resolves it.
    const schema = asyncapi.components.schemas.OrderStatusEvent;
    for (const e of h.events.events) {
      expect(check(e, schema)).toEqual([]);
      expect(e.type).toBe(`degent.mint.order.${e.status}`);
    }
    expect(h.events.events.length).toBeGreaterThanOrEqual(9);
  });
});

describe('degent.mint.order.{status} stays compatible with the platform topic (deps/scribbit/contracts/asyncapi/platform-events.yaml)', () => {
  // The platform schema is canonical for the shared topic; this contract's OrderStatusEvent is the producer's
  // view and must not drift from it. Both files are plain YAML with local $refs only.
  const deref = (doc: any, n: any): any =>
    n?.$ref ? deref(doc, n.$ref.replace(/^#\//, '').split('/').reduce((x: any, k: string) => x?.[k], doc)) : n;
  const ours = asyncapi.channels.orderStatus;
  const ourEvent = deref(asyncapi, asyncapi.components.schemas.OrderStatusEvent);
  const theirs: any = Object.values<any>(platformEvents.channels).find((c) => c.address === ours.address);
  const theirMessage = deref(platformEvents, Object.values<any>(theirs.messages)[0]);
  const theirEvent = deref(platformEvents, theirMessage.payload.allOf[1].properties.data);
  const enumOf = (doc: any, node: any): unknown[] =>
    (deref(doc, node).enum ?? deref(doc, node).oneOf?.flatMap((b: any) => deref(doc, b).enum ?? (b.type === 'null' ? [null] : []))) as unknown[];

  it('the platform declares the channel with the same address and status parameter enum', () => {
    expect(theirs).toBeDefined();
    expect(theirs.parameters.status.enum).toEqual(ours.parameters.status.enum);
    expect(theirs.parameters.status.enum).toEqual([...ORDER_STATUSES]);
  });

  it('same required fields, same property set, same status / previousStatus / network / lane enums', () => {
    expect([...ourEvent.required].sort()).toEqual([...theirEvent.required].sort());
    expect(Object.keys(ourEvent.properties).sort()).toEqual(Object.keys(theirEvent.properties).sort());
    for (const k of ['status', 'previousStatus', 'network', 'lane']) {
      expect(enumOf(asyncapi, ourEvent.properties[k]), k).toEqual(enumOf(platformEvents, theirEvent.properties[k]));
    }
    expect(ourEvent.properties.type.pattern).toBe(theirEvent.properties.type.pattern);
  });

  it('our canonical examples validate against the platform schema', () => {
    const examples = deref(asyncapi, Object.values<any>(ours.messages)[0]).examples;
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) expect(check(ex.payload, theirEvent)).toEqual([]);
  });

  it('every event the service emits validates against the platform schema', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    fundCommit(h, b);
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    expect(h.events.events.length).toBeGreaterThanOrEqual(9);
    for (const e of h.events.events) expect(check(e, theirEvent)).toEqual([]);
  });
});
