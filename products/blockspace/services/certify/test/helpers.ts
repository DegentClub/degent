import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import { expect } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { CertifyService, type CollectionConfig } from '../src/application/certify-service.js';
import { FakeOrd } from '../src/adapters/fake-ord.js';
import { InMemoryAttestationSigner } from '../src/adapters/memory-signer.js';
import { MemorySnapshotStore } from '../src/adapters/memory-store.js';

// ---- contract ------------------------------------------------------------------------------------

type OpenApi = { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: { $ref: string } }>; $ref?: string }> }>>; components: { responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }> } };
export const spec = parse(readFileSync(new URL('../../../../../contracts/openapi/blockspace-collections.yaml', import.meta.url), 'utf8')) as OpenApi;

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true, validateSchema: false });
ajv.addSchema({ ...spec, $id: 'openapi' } as object);

/** Maps a concrete request to the spec's templated path (`/v1/collections/degent/items` → `/v1/collections/{slug}/items`). */
function specPath(path: string): string | undefined {
  return Object.keys(spec.paths).find((p) => new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(path));
}

/** Asserts the response is documented for (method, path, status) and its JSON body validates against the contract. */
export async function conforms(method: string, path: string, res: Response): Promise<any> {
  const p = specPath(path.split('?')[0]!);
  expect(p, `path ${path} is in the contract`).toBeDefined();
  const op = spec.paths[p!]![method.toLowerCase()];
  expect(op, `${method} ${p} is in the contract`).toBeDefined();
  let r = op!.responses[String(res.status)];
  expect(r, `${method} ${p} documents status ${res.status}`).toBeDefined();
  if (r!.$ref) r = spec.components.responses[r!.$ref.split('/').pop()!] as typeof r;
  const ref = r!.content!['application/json']!.schema.$ref;
  const validate = ajv.getSchema('openapi' + ref)!;
  const body = await res.json();
  const ok = validate(body);
  expect(ok, `${method} ${path} ${res.status} body matches ${ref}: ${JSON.stringify(validate.errors)}`).toBe(true);
  return body;
}

// ---- fixtures ------------------------------------------------------------------------------------

export const txid = (tag: string) => createHash('sha256').update(tag).digest('hex');
export const iid = (tag: string, index = 0) => `${txid(tag)}i${index}`;
export const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export const ADMIN = 'test-admin-token-0123456789';
export const PARENT = iid('degent-parent');
export const FIXED_NOW = new Date('2026-09-23T12:00:00.000Z');

export interface World {
  ord: FakeOrd;
  service: CertifyService;
  app: Hono;
  signer: InMemoryAttestationSigner;
  req: (method: string, path: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  refresh: (slug?: string) => Promise<Response>;
}

export function world(collections: CollectionConfig[], ord = new FakeOrd({ height: 900_000, pageSize: 2 })): World {
  const signer = InMemoryAttestationSigner.fromHex('3c'.repeat(32));
  const clock = { now: () => FIXED_NOW };
  const service = new CertifyService({ ord, signer, store: new MemorySnapshotStore(), clock, collections, concurrency: 3 });
  const app = createApp({ service, ord, clock, adminToken: ADMIN });
  const req = async (method: string, path: string, init: { headers?: Record<string, string> } = {}) =>
    app.request(path, { method, headers: init.headers ?? {} });
  return {
    ord,
    service,
    app,
    signer,
    req,
    refresh: (slug = 'degent') => req('POST', `/v1/collections/${slug}/refresh`, { headers: { authorization: `Bearer ${ADMIN}` } }),
  };
}
