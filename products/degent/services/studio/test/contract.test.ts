/**
 * Implementation <-> contract conformance: route parity with contracts/openapi/degent-studio.yaml,
 * every live response validated with ajv (JSON Schema 2020-12, as OpenAPI 3.1 uses), error-code
 * coverage, and every emitted event validated against contracts/asyncapi/degent-studio.yaml.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import { ARTWORK_STATUSES } from '../src/domain/artwork.js';
import { api, declare, makeHarness, payoutProof, signIn, submit, upload, wallet } from './fakes/harness.js';
import { FakeVisionReview, needsHuman, reject } from './fakes/misc.js';
import { jpeg } from './fakes/images.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-studio.yaml'), 'utf8'));
const asyncapi = parse(readFileSync(join(root, 'contracts/asyncapi/degent-studio.yaml'), 'utf8'));
const schemas = openapi.components.schemas;

const ajv = new Ajv2020({ strict: false, allErrors: true });
const formats = ((addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats) as typeof addFormats;
formats(ajv);
ajv.addSchema(openapi, 'studio.yaml');
ajv.addSchema(asyncapi, 'studio-events.yaml');

function validate(ref: string, value: unknown): string[] {
  const v = ajv.getSchema(ref);
  if (!v) throw new Error(`no schema ${ref}`);
  return v(value) ? [] : [`${ref}: ${ajv.errorsText(v.errors)} :: ${JSON.stringify(value).slice(0, 300)}`];
}

function responseSchemaRef(path: string, method: string, status: number): string {
  const op = openapi.paths[path][method];
  const resp = op.responses[String(status)];
  if (!resp) throw new Error(`${method} ${path} has no ${status} response in the contract`);
  const r = resp.$ref ? openapi.components.responses[resp.$ref.split('/').pop()] : resp;
  return `studio.yaml${r.content['application/json'].schema.$ref}`;
}

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

/** Codes the @bsh/edge middleware can emit on our behalf (errors.ts CODES table + middleware codes). */
const EDGE_CODES = [
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'method_not_allowed', 'not_acceptable', 'request_timeout', 'conflict', 'gone',
  'payload_too_large', 'unsupported_media_type', 'unprocessable_entity', 'rate_limited', 'internal_error', 'bad_gateway', 'unavailable',
  'gateway_timeout', 'error', 'cors_origin_denied', 'missing_api_key', 'invalid_api_key', 'insufficient_scope', 'quota_exceeded',
];

describe('OpenAPI contract: degent-studio.yaml', () => {
  it('every implemented route is in the contract and vice versa', () => {
    const h = makeHarness();
    const impl = new Set(
      h.app.routes
        .filter((r) => r.method !== 'ALL' && r.path.startsWith('/v1/'))
        .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`),
    );
    const contract = new Set(
      Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops as object).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`)),
    );
    expect([...impl].sort()).toEqual([...contract].sort());
  });

  it('every error code the service or the edge can emit is in the ErrorCode enum', () => {
    const codes = new Set<string>(EDGE_CODES);
    for (const f of srcFiles(new URL('../src', import.meta.url).pathname)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/DomainError\(\s*'([a-z_]+)'/g)) codes.add(m[1]!);
    }
    for (const c of ['not_found', 'conflict', 'validation_failed', 'unauthorized', 'forbidden', 'illegal_transition']) codes.add(c);
    expect([...codes].filter((c) => !schemas.ErrorCode.enum.includes(c))).toEqual([]);
  });

  it('ArtworkStatus enums agree across domain, OpenAPI and AsyncAPI', () => {
    expect(schemas.ArtworkStatus.enum).toEqual([...ARTWORK_STATUSES]);
    expect(asyncapi.components.schemas.ArtworkStatus.enum).toEqual([...ARTWORK_STATUSES]);
    expect(asyncapi.channels.artworkStatus.parameters.status.enum).toEqual([...ARTWORK_STATUSES]);
  });

  it('live responses validate against the contract schemas (happy paths)', async () => {
    const h = makeHarness();
    const errs: string[] = [];
    const expectOk = async (method: string, path: string, template: string, status: number, init = {}) => {
      const r = await api(h, method.toUpperCase(), path, init);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(status);
      errs.push(...validate(responseSchemaRef(template, method, status), r.body));
      return r;
    };
    await expectOk('get', '/v1/health', '/v1/health', 200);
    await expectOk('get', '/v1/config', '/v1/config', 200);

    const w = wallet(11);
    const ch = await expectOk('post', '/v1/auth/challenge', '/v1/auth/challenge', 201, { json: { address: w.address, network: 'regtest' } });
    const v = await expectOk('post', '/v1/auth/verify', '/v1/auth/verify', 200, {
      json: { message: ch.body.message, signature: w.sign(ch.body.message), address: w.address },
    });
    const token = v.body.token as string;
    await expectOk('get', '/v1/artists/me', '/v1/artists/me', 200, { token });
    await expectOk('put', '/v1/artists/me', '/v1/artists/me', 200, { token, json: { displayName: 'Pepe Painter', payout: payoutProof(wallet(12, 'wpkh'), w.address) } });
    await expectOk('get', `/v1/artists/${w.address}`, '/v1/artists/{address}', 200);

    const s = { wallet: w, address: w.address, token };
    const sub = await declare(h, s);
    errs.push(...validate('studio.yaml#/components/schemas/CreateArtworkResponse', { artwork: sub.artwork, uploadToken: sub.uploadToken }));
    await expectOk('get', `/v1/artworks/${sub.artworkId}`, '/v1/artworks/{id}', 200, { token });
    await expectOk('put', `/v1/artworks/${sub.artworkId}/content`, '/v1/artworks/{id}/content', 200, { bytes: sub.bytes, token: sub.uploadToken });
    await expectOk('get', `/v1/artworks/${sub.artworkId}`, '/v1/artworks/{id}', 200);
    await expectOk('get', '/v1/artworks', '/v1/artworks', 200);
    await expectOk('get', `/v1/artworks?status=approved&artist=${w.address}&page=1&pageSize=5`, '/v1/artworks', 200);
    await expectOk('post', `/v1/artworks/${sub.artworkId}/feature`, '/v1/artworks/{id}/feature', 200, { apiKey: h.reviewerKey, json: { featured: true } });
    await expectOk('post', `/v1/artworks/${sub.artworkId}/review`, '/v1/artworks/{id}/review', 200, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['rule 2: no bow tie'] } });
    await expectOk('post', `/v1/artworks/${sub.artworkId}/review`, '/v1/artworks/{id}/review', 200, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    const roy = { orderId: 'dgt_1', artworkId: sub.artworkId, minterAddress: wallet(13).address, royaltySats: 12_345, fundingTxid: 'ab'.repeat(32), vout: 1, at: '2026-09-24T13:00:00.000Z' };
    await expectOk('post', '/v1/internal/royalties', '/v1/internal/royalties', 201, { apiKey: h.mintKey, json: roy });
    await expectOk('post', '/v1/internal/royalties', '/v1/internal/royalties', 200, { apiKey: h.mintKey, json: roy });
    await expectOk('get', '/v1/artists/me/royalties', '/v1/artists/me/royalties', 200, { token });
    await expectOk('delete', `/v1/artworks/${sub.artworkId}`, '/v1/artworks/{id}', 200, { token });
    expect(errs).toEqual([]);
  });

  it('live responses validate for the ADR-0012 endpoints (editions, curation rank, appeals, notify, royalty edition)', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(reject('rule 2: no bow tie')) });
    const errs: string[] = [];
    const expectOk = async (method: string, path: string, template: string, status: number, init = {}) => {
      const r = await api(h, method.toUpperCase(), path, init);
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(status);
      errs.push(...validate(responseSchemaRef(template, method, status), r.body));
      return r;
    };
    const s = await signIn(h, 51);
    const notify = await expectOk('put', '/v1/artists/me', '/v1/artists/me', 200, { token: s.token, json: { notify: { webhookUrl: 'https://hooks.example.com/x', telegramChatId: '123456' } } });
    expect(notify.body.notifyWebhookSecret).toBeDefined();
    await expectOk('get', '/v1/artists/me', '/v1/artists/me', 200, { token: s.token });
    const created = await api(h, 'POST', '/v1/artworks', { token: s.token, json: { title: 'Capped', contentType: 'image/jpeg', contentLength: 250_000, maxEditions: 5 } });
    errs.push(...validate('studio.yaml#/components/schemas/CreateArtworkResponse', created.body));
    await expectOk('put', `/v1/artworks/${created.body.artwork.id}/editions`, '/v1/artworks/{id}/editions', 200, { token: s.token, json: { maxEditions: null } });
    const sub = await submit(h, s); // rejected by the fake vision reviewer
    const ap = await expectOk('post', `/v1/artworks/${sub.artworkId}/appeal`, '/v1/artworks/{id}/appeal', 201, { token: s.token, json: { message: 'Please look again.' } });
    expect(ap.body.artwork.appeals).toHaveLength(1);
    await expectOk('get', '/v1/appeals', '/v1/appeals', 200, { apiKey: h.reviewerKey });
    await expectOk('get', `/v1/artworks/${sub.artworkId}`, '/v1/artworks/{id}', 200, { token: s.token });
    await expectOk('post', `/v1/artworks/${sub.artworkId}/review`, '/v1/artworks/{id}/review', 200, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    await expectOk('get', '/v1/appeals?status=granted', '/v1/appeals', 200, { apiKey: h.reviewerKey });
    await expectOk('post', `/v1/artworks/${sub.artworkId}/feature`, '/v1/artworks/{id}/feature', 200, { apiKey: h.reviewerKey, json: { featured: true, rank: 1 } });
    await expectOk('put', `/v1/artworks/${sub.artworkId}/editions`, '/v1/artworks/{id}/editions', 200, { token: s.token, json: { maxEditions: 1 } });
    const roy = { orderId: 'dgt_c1', artworkId: sub.artworkId, minterAddress: null, royaltySats: 1_000, fundingTxid: 'cd'.repeat(32), vout: 1, at: '2026-09-24T13:00:00.000Z', edition: 1 };
    await expectOk('post', '/v1/internal/royalties', '/v1/internal/royalties', 201, { apiKey: h.mintKey, json: roy });
    const sold = await expectOk('get', '/v1/artworks?available=false', '/v1/artworks', 200);
    expect(sold.body.items[0]).toMatchObject({ id: sub.artworkId, soldOut: true, mintedEditions: 1, featuredRank: 1 });
    await expectOk('get', '/v1/artworks?available=true', '/v1/artworks', 200);
    await expectOk('get', '/v1/artists/me/royalties', '/v1/artists/me/royalties', 200, { token: s.token });
    await expectOk('get', '/v1/config', '/v1/config', 200);
    // errors on the new routes use the Error shape
    const other = await signIn(h, 52);
    for (const [method, path, status, init] of [
      ['POST', `/v1/artworks/${sub.artworkId}/appeal`, 409, { token: s.token, json: { message: 'again' } }],
      ['PUT', `/v1/artworks/${sub.artworkId}/editions`, 422, { token: s.token, json: { maxEditions: 1, x: 1 } }],
      ['PUT', `/v1/artworks/${sub.artworkId}/editions`, 403, { token: other.token, json: { maxEditions: 2 } }],
      ['GET', '/v1/appeals?status=nope', 422, { apiKey: h.reviewerKey }],
      ['GET', '/v1/appeals', 403, { apiKey: h.mintKey }],
    ] as Array<[string, string, number, Parameters<typeof api>[3]]>) {
      const r = await api(h, method, path, init);
      expect(r.status, `${method} ${path}`).toBe(status);
      errs.push(...validate('studio.yaml#/components/schemas/Error', r.body));
    }
    await h.service.notificationsIdle();
    expect(h.webhooks.received.length).toBeGreaterThan(0);
    expect(errs).toEqual([]);
  });

  it('the ArtistNotification kinds in the contract are the ones the service sends', async () => {
    const { NOTIFICATION_KINDS } = await import('../src/domain/notifications.js');
    expect(schemas.ArtistNotification.properties.kind.enum).toEqual([...NOTIFICATION_KINDS]);
    expect(schemas.AppealStatus.enum).toEqual(['open', 'granted', 'denied']);
  });

  it('content bytes match the declared headers in the contract', async () => {
    const h = makeHarness();
    const s = await signIn(h, 21);
    const sub = await submit(h, s);
    const r = await api(h, 'GET', `/v1/artworks/${sub.artworkId}/content`);
    expect(r.status).toBe(200);
    const op = openapi.paths['/v1/artworks/{id}/content'].get;
    expect(Object.keys(op.responses['200'].content)).toContain(r.headers.get('content-type'));
    expect(r.headers.get('etag')).toBe(`"${sha256Hex(sub.bytes)}"`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(op.responses['304']).toBeDefined();
  });

  it('error responses validate against Error (each documented status)', async () => {
    const h = makeHarness();
    const errs: string[] = [];
    const cases: Array<[string, string, number, Parameters<typeof api>[3]]> = [
      ['GET', '/v1/nope', 404, {}],
      ['GET', '/v1/artists/me', 401, {}],
      ['POST', '/v1/auth/challenge', 415, { headers: { 'content-type': 'text/plain' }, json: {} }],
      ['POST', '/v1/auth/challenge', 422, { json: { address: 'nope', network: 'regtest' } }],
      ['POST', '/v1/auth/verify', 401, { json: { message: 'x', signature: 'y', address: wallet(1).address } }],
      ['GET', `/v1/artists/${wallet(99).address}`, 404, {}],
      ['POST', '/v1/artworks/art_x/review', 401, { json: { decision: 'approve' } }],
      ['POST', '/v1/artworks/art_x/review', 403, { apiKey: h.mintKey, json: { decision: 'approve' } }],
      ['POST', '/v1/internal/royalties', 403, { apiKey: h.reviewerKey, json: {} }],
      ['GET', '/v1/artworks?status=reviewing', 401, {}],
      ['GET', '/v1/artworks?page=0', 422, {}],
    ];
    for (const [method, path, status, init] of cases) {
      const r = await api(h, method, path, init);
      expect(r.status, `${method} ${path}`).toBe(status);
      errs.push(...validate('studio.yaml#/components/schemas/Error', r.body));
      expect(r.body.error.requestId).toBe(r.headers.get('x-request-id'));
    }
    expect(errs).toEqual([]);
  });

  it('needsHuman artworks validate too', async () => {
    const h = makeHarness({ vision: new FakeVisionReview(needsHuman()) });
    const s = await signIn(h, 31);
    const sub = await declare(h, s, { bytes: jpeg(512, 512, 210_000) });
    const a = await upload(h, sub);
    expect(a.status).toBe('reviewing');
    expect(a.needsHuman).toBe(true);
    expect(validate('studio.yaml#/components/schemas/Artwork', a)).toEqual([]);
  });
});

describe('AsyncAPI contract: degent-studio.yaml', () => {
  it('every emitted event validates against ArtworkStatusEvent and its type equals the routing key', async () => {
    const h = makeHarness();
    const s = await signIn(h, 41);
    const sub = await submit(h, s);
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'reject', reasons: ['x'] } });
    await api(h, 'POST', `/v1/artworks/${sub.artworkId}/review`, { apiKey: h.reviewerKey, json: { decision: 'approve' } });
    await api(h, 'DELETE', `/v1/artworks/${sub.artworkId}`, { token: s.token });
    const errs: string[] = [];
    for (const e of h.events.events) {
      errs.push(...validate('studio-events.yaml#/components/schemas/ArtworkStatusEvent', e));
      expect(e.type).toBe(`degent.artwork.${e.status}`);
      expect(asyncapi.channels.artworkStatus.parameters.status.enum).toContain(e.status);
    }
    expect(errs).toEqual([]);
    expect(h.events.events.map((e) => e.status)).toEqual(['submitted', 'reviewing', 'approved', 'rejected', 'approved', 'delisted']);
    expect(h.events.events.map((e) => e.eventId)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `${sub.artworkId}:${i}`));
  });

  it('the example payload in the contract validates against its own schema', () => {
    const example = asyncapi.components.messages.ArtworkStatusChanged.examples[0].payload;
    expect(validate('studio-events.yaml#/components/schemas/ArtworkStatusEvent', example)).toEqual([]);
  });
});
