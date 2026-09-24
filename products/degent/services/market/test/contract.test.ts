/**
 * Implementation <-> contract conformance: routes, error codes, status enums, live responses and
 * published events, against contracts/openapi/degent-market.yaml and contracts/asyncapi/degent-market.yaml.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LISTING_STATUSES, MARKET_ERROR_CODES } from '@bsh/degent-market-sdk';
import { listViaApi, makeHarness } from './fakes/harness.js';
import { INSCRIPTION_ID, walletSign } from './fakes/keys.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-market.yaml'), 'utf8'));
const asyncapi = parse(readFileSync(join(root, 'contracts/asyncapi/degent-market.yaml'), 'utf8'));

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

/** Minimal JSON-schema check for the subset the contracts use. */
function check(value: unknown, schema: Record<string, any>, schemas: Record<string, any>, path = '$'): string[] {
  if (schema.$ref) return check(value, schemas[schema.$ref.split('/').pop()], schemas, path);
  if (schema.oneOf) return schema.oneOf.some((s: any) => check(value, s, schemas, path).length === 0) ? [] : [`${path}: matches no oneOf branch`];
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
      if (ps) errs.push(...check(sub, ps, schemas, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not in contract`);
      else if (typeof schema.additionalProperties === 'object') errs.push(...check(sub, schema.additionalProperties, schemas, `${path}.${k}`));
    }
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((x, i) => errs.push(...check(x, schema.items, schemas, `${path}[${i}]`)));
  return errs;
}
const S = openapi.components.schemas;
const response = (path: string, method: string, status: number) => openapi.paths[path][method].responses[String(status)].content['application/json'].schema;

describe('OpenAPI contract', () => {
  it('every implemented route is in the contract and vice versa', () => {
    const h = makeHarness();
    const impl = new Set(h.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`));
    const contract = new Set(Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops as object).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`)));
    expect([...impl].sort()).toEqual([...contract].sort());
  });

  it('every error code the service can emit is in the contract, and the SDK enum equals the contract enum', () => {
    const codes = new Set<string>();
    for (const f of srcFiles(new URL('../src', import.meta.url).pathname)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(?:DomainError\(|SettlementError\(|errorBody\()'([a-z_]+)'/g)) codes.add(m[1]!);
    }
    expect([...codes].filter((c) => !S.ErrorCode.enum.includes(c))).toEqual([]);
    expect(S.ErrorCode.enum).toEqual([...MARKET_ERROR_CODES]);
  });

  it('listing status enums agree across SDK, OpenAPI and AsyncAPI', () => {
    expect(S.ListingStatus.enum).toEqual([...LISTING_STATUSES]);
    expect(asyncapi.components.schemas.ListingStatus.enum).toEqual([...LISTING_STATUSES]);
    expect(asyncapi.channels.listingStatus.parameters.status.enum).toEqual([...LISTING_STATUSES]);
  });

  it('live responses validate against their schemas (list, buy, dummies, errors, events)', async () => {
    const h = makeHarness({ settings: { buysEnabled: true } });
    const expectValid = (value: unknown, schema: Record<string, any>) => expect(check(value, schema, S)).toEqual([]);
    expectValid((await h.request('GET', '/v1/health')).body, response('/v1/health', 'get', 200));
    expectValid((await h.request('GET', '/v1/config')).body, response('/v1/config', 'get', 200));
    expectValid((await h.request('GET', '/v1/fees')).body, response('/v1/fees', 'get', 200));
    const prep = await h.request('POST', '/v1/listings/prepare', { inscriptionId: INSCRIPTION_ID, sellerAddress: h.seller.tr.address, sellerPublicKey: h.seller.publicKeyHex, priceSats: 50_000 });
    expectValid(prep.body, response('/v1/listings/prepare', 'post', 200));
    expectValid((await h.request('POST', '/v1/auth/challenge', { action: 'cancel', address: h.seller.tr.address, inscriptionId: INSCRIPTION_ID })).body, response('/v1/auth/challenge', 'post', 200));
    const created = await listViaApi(h);
    expectValid(created.body, response('/v1/listings', 'post', 201));
    expectValid((await h.request('GET', '/v1/listings')).body, response('/v1/listings', 'get', 200));
    expectValid((await h.request('GET', `/v1/listings/${INSCRIPTION_ID}`)).body, response('/v1/listings/{id}', 'get', 200));
    const buy = await h.request('POST', '/v1/buy/prepare', { inscriptionId: INSCRIPTION_ID, buyerAddress: h.buyer.tr.address, buyerPublicKey: h.buyer.publicKeyHex });
    expectValid(buy.body, response('/v1/buy/prepare', 'post', 200));
    const sub = await h.request('POST', '/v1/buy/submit', { sessionId: buy.body.sessionId, signedPsbt: walletSign(buy.body.psbtHex, h.buyer.priv, [0, 1, 3], undefined, { finalize: true }) });
    expectValid(sub.body, response('/v1/buy/submit', 'post', 200));
    h.chain.utxos.set(h.buyer.tr.address, [{ txid: 'c3'.repeat(32), vout: 5, value: 90_000n, confirmed: true }]);
    const dummies = await h.request('POST', '/v1/buy/prepare', { inscriptionId: INSCRIPTION_ID, buyerAddress: h.buyer.tr.address, buyerPublicKey: h.buyer.publicKeyHex });
    expectValid(dummies.body, S.Error); // the listing is pending now: a structured error
    expectValid((await h.request('GET', '/v1/nope')).body, S.Error);
    const ev = asyncapi.components.schemas;
    for (const e of h.events_) {
      expect(check(e, ev.ListingStatusEvent, ev)).toEqual([]);
      expect(e.type).toBe(`degent.market.listing.${e.status}`);
    }
    expect(new Set(h.events_.map((e) => e.eventId)).size).toBe(h.events_.length);
  });

  it('the padding-round response validates too', async () => {
    const h = makeHarness({ settings: { buysEnabled: true } });
    await listViaApi(h);
    h.chain.utxos.set(h.buyer.tr.address, [{ txid: 'c3'.repeat(32), vout: 5, value: 90_000n, confirmed: true }]);
    const res = await h.request('POST', '/v1/buy/prepare', { inscriptionId: INSCRIPTION_ID, buyerAddress: h.buyer.tr.address, buyerPublicKey: h.buyer.publicKeyHex });
    expect(res.body.kind).toBe('dummies');
    expect(check(res.body, response('/v1/buy/prepare', 'post', 200), S)).toEqual([]);
  });
});
