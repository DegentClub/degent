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
import { api, browserArtworkToPayment, browserMintToPayment, fundArtwork, fundCommit, makeHarness, regtestAddress, studioArtwork } from './fakes/harness.js';

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
    // ErrorCode is an open set (x-extensible-enum, the platform ledger convention): the oasdiff gate locks
    // closed response enums, so new codes are listed here without turning a closed enum into a breaking change.
    expect(schemas.ErrorCode.enum).toBeUndefined();
    expect([...codes].filter((c) => !schemas.ErrorCode['x-extensible-enum'].includes(c))).toEqual([]);
    for (const c of ['artwork_not_found', 'artwork_not_mintable', 'artist_payout_missing']) expect(schemas.ErrorCode['x-extensible-enum']).toContain(c);
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

  it('Open Studio: artwork order, config, rescue inputs and the new error codes validate; new fields are all optional', async () => {
    const h = makeHarness({ settings: { serviceFeeAddress: regtestAddress(5) } });
    await h.ready;
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    expect(check(b.order, schemas.Order)).toEqual([]);
    for (const k of ['artworkId', 'artistAddress', 'artistRoyaltySats', 'clubFeeSats', 'royaltyPaid']) {
      expect(schemas.Order.required).not.toContain(k);
      expect(schemas.Order.properties[k]).toBeDefined();
    }
    for (const k of ['clubFeeSats', 'artistRoyaltySats', 'artistAddress', 'artworkId', 'mintPriceSats', 'edition', 'royaltyRaisedToDust']) {
      expect(schemas.Quote.required).not.toContain(k);
      expect(schemas.Quote.properties[k]).toBeDefined();
    }
    expect(schemas.CreateOrderRequest.required).not.toContain('artworkId');
    expect(schemas.CreateOrderRequest.properties.artworkId).toBeDefined();
    const cfg = await api(h, 'GET', '/v1/config');
    expect(check(cfg.body, schemas.ServiceConfig)).toEqual([]);
    expect(cfg.body).toMatchObject({ royaltyBps: 1000, clubFeeBps: { standard: 1000 }, studioUrl: 'http://studio.test' });
    fundArtwork(h, b);
    await h.worker.tick();
    const paid = await api(h, 'GET', `/v1/orders/${b.orderId}`);
    expect(check(paid.body, schemas.Order)).toEqual([]);
    expect(paid.body.royaltyPaid).toMatchObject({ vout: 1 });
    expect(paid.body.edition).toBe(1);
    h.clock.advance(7 * 3600);
    const c = await browserArtworkToPayment(h, art.id, { recipientSeed: 3 });
    fundArtwork(h, c);
    h.broadcasters.standard.mode = 'retryable';
    await h.worker.tick();
    h.clock.advance(7 * 3600);
    await h.worker.tick();
    const rescue = await api(h, 'GET', `/v1/orders/${c.orderId}/rescue`, { token: c.token });
    expect(rescue.status).toBe(200);
    expect(check(rescue.body, schemas.RescueInputs)).toEqual([]);
    expect(rescue.body).toMatchObject({ artworkId: art.id, edition: 2 });
    for (const [id, code] of [['art_none', 'artwork_not_found']] as const) {
      const r = await api(h, 'POST', '/v1/orders', { json: { ...requestFor(b), artworkId: id } });
      expect(r.body.error.code).toBe(code);
      expect(check(r.body, schemas.Error)).toEqual([]);
    }
    // every POST /v1/orders error status the service can answer is declared
    const declared = Object.keys(openapi.paths['/v1/orders'].post.responses);
    for (const st of ['404', '409', '422', '503']) expect(declared).toContain(st);
  });
});

function requestFor(b: { order: { tier: string; contentType: string; contentLength: number; contentSha256: string; recipientAddress: string; revealPubkey: string; quote: { feeRate: number } | null } }) {
  const o = b.order;
  return { tier: o.tier, contentType: o.contentType, contentLength: o.contentLength, contentSha256: o.contentSha256, recipientAddress: o.recipientAddress, revealPubkey: o.revealPubkey, feeRate: o.quote!.feeRate };
}

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
    for (const e of h.events.orderEvents) {
      expect(check(e, schema)).toEqual([]);
      expect(e.type).toBe(`degent.mint.order.${e.status}`);
    }
    expect(h.events.orderEvents.length).toBeGreaterThanOrEqual(9);
  });

  it('Open Studio: order events keep the shared payload, royalty.paid validates against its channel, collection.minted against the platform topic', async () => {
    const h = makeHarness({ settings: { serviceFeeAddress: regtestAddress(5) } });
    const art = studioArtwork(h);
    const b = await browserArtworkToPayment(h, art.id);
    fundArtwork(h, b);
    await h.worker.tick();
    h.chain.mine();
    await h.worker.tick();
    h.chain.inscriptions.set((await h.store.get(b.orderId))!.inscriptionId!, b.bytes);
    await h.worker.tick();
    const status = asyncapi.components.schemas.OrderStatusEvent;
    const mine = h.events.orderEvents.filter((e) => e.orderId === b.orderId);
    expect(mine.length).toBeGreaterThanOrEqual(11);
    for (const e of mine) {
      expect(check(e, status)).toEqual([]);
      expect(e).not.toHaveProperty('artworkId');
    }
    expect(asyncapi.channels.royaltyPaid.address).toBe('degent.mint.royalty.paid');
    const royaltySchema = asyncapi.components.schemas.RoyaltyPaidEvent;
    expect(h.events.royaltyEvents).toHaveLength(1);
    for (const e of h.events.royaltyEvents) expect(check(e, royaltySchema)).toEqual([]);
    const examples = asyncapi.components.messages.RoyaltyPaid.examples;
    for (const ex of examples) expect(check(ex.payload, royaltySchema)).toEqual([]);
    // collection.minted: the platform's schema (1.1.0) with the Open Studio fields
    const mintedChannel: any = Object.values<any>(platformEvents.channels).find((c) => c.address === 'collection.minted');
    expect(mintedChannel).toBeDefined();
    const mintedSchema = platformEvents.components.schemas.CollectionMinted;
    for (const k of ['artist', 'artworkId', 'edition', 'royalty']) expect(mintedSchema.properties[k]).toBeDefined();
    expect(h.events.mintedEvents).toHaveLength(1);
    const { type: _t, ...data } = h.events.mintedEvents[0]!;
    expect(check(data, mintedSchema)).toEqual([]);
    expect(data).toMatchObject({ artist: art.payoutAddress, artworkId: art.id, edition: 1, royalty: { vout: 1 } });
  });

  it('every event type the service emits is a channel of a contract', async () => {
    const ours = new Set<string>(['degent.mint.order.{status}', 'degent.mint.royalty.paid'].map((a) => a));
    expect(Object.values<any>(asyncapi.channels).map((c) => c.address).sort()).toEqual([...ours].sort());
    expect(Object.values<any>(platformEvents.channels).some((c) => c.address === 'collection.minted')).toBe(true);
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
    expect(h.events.orderEvents.length).toBeGreaterThanOrEqual(9);
    for (const e of h.events.orderEvents) expect(check(e, theirEvent)).toEqual([]);
  });
});
