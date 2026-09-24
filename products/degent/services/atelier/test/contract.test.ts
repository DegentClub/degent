/**
 * Implementation <-> contract conformance for contracts/openapi/degent-atelier.yaml: route parity,
 * live responses validated with ajv (JSON Schema 2020-12, as OpenAPI 3.1 uses), error-code coverage,
 * and the tier numbers cross-checked against the mint's contract (read-only).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PLACARDS, TIERS } from '../src/domain/tiers.js';
import { FakeImageProvider } from '../src/providers/fake.js';
import { auth, jsonInit, makeHarness, type Harness } from './fakes/harness.js';

const root = new URL('../../../../../', import.meta.url).pathname;
const doc = parse(readFileSync(join(root, 'contracts/openapi/degent-atelier.yaml'), 'utf8'));
const mintDoc = parse(readFileSync(join(root, 'contracts/openapi/degent-mint.yaml'), 'utf8'));
const schemas = doc.components.schemas;

// The whole OpenAPI document is registered as one schema resource so `#/components/schemas/X` refs resolve.
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats is CJS with a default export; under ESM interop it may arrive wrapped once.
const formats = ((addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats) as typeof addFormats;
formats(ajv);
ajv.addSchema(doc, 'atelier.yaml');

function validate(schemaName: string, value: unknown): void {
  const v = ajv.getSchema(`atelier.yaml#/components/schemas/${schemaName}`);
  if (!v) throw new Error(`no schema ${schemaName}`);
  const ok = v(value);
  expect(ok, `${schemaName}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value).slice(0, 400)}`).toBe(true);
}

function responseSchemaName(path: string, method: string, status: number): string {
  const op = doc.paths[path][method];
  const resp = op.responses[String(status)];
  if (!resp) throw new Error(`${method} ${path} has no ${status} response in the contract`);
  const r = resp.$ref ? doc.components.responses[resp.$ref.split('/').pop()] : resp;
  return r.content['application/json'].schema.$ref.split('/').pop();
}

async function expectContract(res: Response, path: string, method: string): Promise<any> {
  const body = await res.json();
  validate(responseSchemaName(path, method, res.status), body);
  return body;
}

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? srcFiles(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

describe('OpenAPI contract: degent-atelier.yaml', () => {
  let h: Harness;
  let token: string;
  let art: Uint8Array;

  beforeAll(async () => {
    h = makeHarness({ quotas: { sessionDailyImages: 3 } });
    const [img] = await new FakeImageProvider().generate({ prompt: 'contract', size: '1024x1024', n: 1 });
    art = img!.bytes;
  });

  it('every implemented route is in the contract and vice versa', () => {
    const impl = new Set(h.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:(\w+)/g, '{$1}')}`));
    const contract = new Set(Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops as object).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`)));
    expect([...impl].sort()).toEqual([...contract].sort());
  });

  it('service endpoints and a full generate -> finalize flow match the response schemas', async () => {
    await expectContract(await h.req('/v1/health'), '/v1/health', 'get');
    await expectContract(await h.req('/v1/config'), '/v1/config', 'get');
    const s = await expectContract(await h.req('/v1/sessions', { method: 'POST' }), '/v1/sessions', 'post');
    token = s.token;
    const acc = await expectContract(await h.req('/v1/generate', jsonInit(token, { brief: 'pharaoh', palette: 'gold', mood: null, placard: 'DEGEN', tier: 'standard', variations: 2, seed: 7 })), '/v1/generate', 'post');
    await expectContract(await h.req(`/v1/jobs/${acc.jobId}`, { headers: auth(token) }), '/v1/jobs/{id}', 'get'); // queued
    await h.service.tick();
    const job = await expectContract(await h.req(`/v1/jobs/${acc.jobId}`, { headers: auth(token) }), '/v1/jobs/{id}', 'get'); // done
    expect(job.status).toBe('done');
    await expectContract(await h.req(`/v1/candidates/${job.candidates[0].id}/finalize`, jsonInit(token, { tier: 'standard', placard: 'DEGEN' })), '/v1/candidates/{id}/finalize', 'post');
  });

  it('upload responses (framed and pass-through) match the schema', async () => {
    const t = await h.session();
    const framed = await h.req('/v1/upload?tier=standard&placard=DEGENT', { method: 'POST', headers: auth(t, { 'content-type': 'application/octet-stream' }), body: art });
    expect(framed.status).toBe(200);
    await expectContract(framed, '/v1/upload', 'post');
    const plain = new Uint8Array(await sharp(Buffer.from(art)).jpeg({ quality: 100 }).toBuffer()); // ~1024^2 square JPEG
    const r = await h.req('/v1/upload?tier=large&frame=false', { method: 'POST', headers: auth(t, { 'content-type': 'image/jpeg' }), body: plain });
    expect(r.status).toBe(200);
    await expectContract(r, '/v1/upload', 'post');
  });

  it('error responses (service and edge generated) match the Error schema', async () => {
    await expectContract(await h.req('/v1/jobs/abcdefgh1234', { headers: auth(token) }), '/v1/jobs/{id}', 'get'); // 404
    await expectContract(await h.req('/v1/jobs/abcdefgh1234'), '/v1/jobs/{id}', 'get'); // 401
    await expectContract(await h.req('/v1/generate', jsonInit(token, { brief: 'x', placard: 'NOPE', tier: 'standard' })), '/v1/generate', 'post'); // 422 + details
    await expectContract(await h.req('/v1/generate', jsonInit(token, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard', variations: 4 })), '/v1/generate', 'post'); // 429 quota
    await expectContract(await h.req('/v1/generate', { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: '{nope' }), '/v1/generate', 'post'); // 400
    await expectContract(
      await h.req('/v1/upload?tier=standard&placard=DEGEN', { method: 'POST', headers: auth(token, { 'content-type': 'application/octet-stream', 'content-length': String(9 * 1024 * 1024) }), body: new Uint8Array(9 * 1024 * 1024) }),
      '/v1/upload',
      'post',
    ); // 413 from @bsh/edge bodyLimit
    const capped = makeHarness({ quotas: { globalDailyCostCents: 1 } });
    const ct = await capped.session();
    await expectContract(await capped.req('/v1/generate', jsonInit(ct, { brief: 'pharaoh', placard: 'DEGEN', tier: 'standard' })), '/v1/generate', 'post'); // 503
    const limited = makeHarness({ rateLimitPerMinute: 1 });
    await limited.req('/v1/health');
    const rl = await limited.req('/v1/sessions', { method: 'POST' });
    expect(rl.status).toBe(429);
    await expectContract(rl, '/v1/sessions', 'post'); // 429 from @bsh/edge rateLimit
    const nf = await h.req('/v1/content/' + '0'.repeat(64));
    validate('Error', await nf.json());
  });

  it('every error code the service can emit is in the ErrorCode enum', () => {
    const codes = new Set<string>();
    for (const f of srcFiles(new URL('../src', import.meta.url).pathname)) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/AtelierError\(\s*\d{3},\s*'([a-z_]+)'/g)) codes.add(m[1]!);
      for (const m of s.matchAll(/code: isProv \? '([a-z_]+)' : '([a-z_]+)'/g)) codes.add(m[1]!).add(m[2]!);
    }
    const union = readFileSync(new URL('../src/domain/errors.ts', import.meta.url), 'utf8').match(/export type ErrorCode =([^;]+);/)![1]!;
    for (const m of union.matchAll(/'([a-z_]+)'/g)) codes.add(m[1]!);
    // codes @bsh/edge emits on our behalf
    for (const c of ['rate_limited', 'payload_too_large', 'bad_request', 'cors_origin_denied', 'not_found', 'internal_error']) codes.add(c);
    expect([...codes].filter((c) => !schemas.ErrorCode.enum.includes(c))).toEqual([]);
    expect(codes.size).toBeGreaterThan(10);
  });

  it('Tier and Placard enums match the implementation; tier byte ranges match the mint contract', () => {
    expect(schemas.Tier.enum).toEqual(TIERS.map((t) => t.tier));
    expect(schemas.Placard.enum).toEqual([...PLACARDS]);
    expect(mintDoc.components.schemas.Tier.enum).toEqual(TIERS.map((t) => t.tier));
    const prose: string = mintDoc.info.description.replace(/\s+/g, ' ');
    for (const t of TIERS) {
      const m = new RegExp('`' + t.tier + '` \\([^)]*?([\\d,]+)-([\\d,]+) B\\)').exec(prose);
      expect(m, `mint contract states the ${t.tier} range`).not.toBeNull();
      const [min, max] = [Number(m![1]!.replace(/,/g, '')), Number(m![2]!.replace(/,/g, ''))];
      expect([min, max], t.tier).toEqual([t.minBytes, t.maxBytes]);
    }
  });
});
