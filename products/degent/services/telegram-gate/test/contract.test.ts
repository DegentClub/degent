/**
 * Implementation <-> contract conformance for contracts/openapi/degent-telegram-gate.yaml: routes, error codes,
 * request shapes and live responses. The web page's side (what /verify sends) is asserted in
 * products/degent/apps/web/test/gate-contract.test.ts against the same file.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { linkFor, makeGate, post, wallet } from './helpers.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-telegram-gate.yaml'), 'utf8'));
const schemas = openapi.components.schemas;

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

/** Minimal JSON-schema check for the subset the contract uses. */
function check(value: unknown, schema: Record<string, any>, path = '$'): string[] {
  if (schema.$ref) return check(value, schemas[schema.$ref.split('/').pop()], path);
  if (schema.oneOf) return schema.oneOf.some((s: any) => check(value, s, path).length === 0) ? [] : [`${path}: matches no oneOf branch`];
  const errs: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: ${actual} not ${types}`];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${String(value)} not in enum`);
  if ('const' in schema && schema.const !== value) errs.push(`${path}: not ${schema.const}`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`);
  if (schema.format === 'date-time' && typeof value === 'string' && Number.isNaN(Date.parse(value))) errs.push(`${path}: not a date-time`);
  if (actual === 'object') {
    const v = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: missing`);
    for (const [k, sub] of Object.entries(v)) {
      const ps = schema.properties?.[k];
      if (ps) errs.push(...check(sub, ps, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}.${k}: not in contract`);
    }
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((x, i) => errs.push(...check(x, schema.items, `${path}[${i}]`)));
  return errs;
}

const responseSchema = (path: string, method: string, status: number) => openapi.paths[path][method].responses[String(status)].content['application/json'].schema;
const requestSchema = (path: string) => openapi.paths[path].post.requestBody.content['application/json'].schema;

describe('OpenAPI contract (degent-telegram-gate)', () => {
  it('every implemented route is in the contract and vice versa', () => {
    const g = makeGate();
    const impl = new Set(g.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method.toLowerCase()} ${r.path}`));
    const contract = new Set(Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m} ${p}`)));
    expect([...impl].sort()).toEqual([...contract].sort());
  });

  it('every error code the service can emit is in the ErrorCode enum, and vice versa', () => {
    const codes = new Set<string>();
    for (const f of srcFiles(new URL('../src', import.meta.url).pathname)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/(?:GateError\(|errorBody\()'([a-z_]+)'/g)) codes.add(m[1]!);
    }
    expect([...codes].sort()).toEqual([...schemas.ErrorCode.enum].sort());
  });

  it('request shapes: the /verify page sends exactly {token, address, message, signature}', () => {
    expect(requestSchema('/gate/verify')).toEqual({ $ref: '#/components/schemas/GateVerifyRequest' });
    expect(schemas.GateVerifyRequest.required).toEqual(['token', 'address', 'message', 'signature']);
    expect(Object.keys(schemas.GateVerifyRequest.properties)).toEqual(['token', 'address', 'message', 'signature']);
    expect(schemas.GateChallengeRequest.required).toEqual(['token', 'address']);
  });

  it('the link token the bot hands out matches the contract (and the web page\'s readGateToken)', async () => {
    const g = makeGate();
    const token = await linkFor(g, 123456789);
    expect(check(token, schemas.LinkToken)).toEqual([]);
    expect(schemas.LinkToken.pattern).toBe('^[A-Za-z0-9_-]{8,128}$');
  });

  it('live responses match their schemas: health, challenge, verify, errors, admin, stats', async () => {
    const w = wallet(1);
    const admin = wallet(2);
    const g = makeGate({ holdings: { [w.address]: [4113] }, settings: { adminAddresses: [admin.address] } });

    const health = await g.app.request('/gate/health');
    expect(check(await health.json(), responseSchema('/gate/health', 'get', 200))).toEqual([]);

    const token = await linkFor(g, 42);
    const chBody = { token, address: w.address };
    expect(check(chBody, requestSchema('/gate/challenge'))).toEqual([]);
    const ch = (await (await post(g, '/gate/challenge', chBody)).json()) as { message: string };
    expect(check(ch, responseSchema('/gate/challenge', 'post', 200))).toEqual([]);

    const vBody = { token, address: w.address, message: ch.message, signature: w.sign(ch.message) };
    expect(check(vBody, requestSchema('/gate/verify'))).toEqual([]);
    const v = await post(g, '/gate/verify', vBody);
    expect(v.status).toBe(200);
    expect(check(await v.json(), responseSchema('/gate/verify', 'post', 200))).toEqual([]);

    const again = await post(g, '/gate/verify', vBody);
    expect(again.status).toBe(401);
    expect(openapi.paths['/gate/verify'].post.responses['401']).toBeDefined();
    expect(check(await again.json(), schemas.Error)).toEqual([]);

    const ach = (await (await post(g, '/gate/admin/challenge', { address: admin.address })).json()) as { message: string };
    expect(check(ach, responseSchema('/gate/admin/challenge', 'post', 200))).toEqual([]);
    const session = (await (await post(g, '/gate/admin/verify', { address: admin.address, message: ach.message, signature: admin.sign(ach.message) })).json()) as { token: string };
    expect(check(session, responseSchema('/gate/admin/verify', 'post', 200))).toEqual([]);
    await g.service.reverifyAll();
    const stats = await g.app.request('/gate/stats', { headers: { authorization: `Bearer ${session.token}` } });
    expect(check(await stats.json(), responseSchema('/gate/stats', 'get', 200))).toEqual([]);
  });

  it('declares every status the routes return', async () => {
    const g = makeGate();
    const res = await post(g, '/gate/challenge', { token: 'x'.repeat(50), address: wallet(1).address });
    expect(res.status).toBe(401);
    expect(openapi.paths['/gate/challenge'].post.responses['401']).toBeDefined();
  });
});
