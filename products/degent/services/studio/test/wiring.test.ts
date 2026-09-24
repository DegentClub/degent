/** The composition root builds a working service from a regtest config, with and without sqlite/fs. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey } from '@bsh/edge';
import { signBip322Simple } from '@bsh/identity';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/wiring.js';
import { silentLogger } from '../src/application/logger.js';
import { addr, key } from './fakes/harness.js';
import { squareArt } from './fakes/images.js';

const dir = mkdtempSync(join(tmpdir(), 'degent-studio-wiring-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function roundTrip(app: { request: (p: string, init?: RequestInit) => Response | Promise<Response> }, reviewerKey: string) {
  const priv = key(77);
  const address = addr('tr', priv);
  const ch = await (await app.request('/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, network: 'regtest' }) })).json() as { message: string };
  const v = await app.request('/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: ch.message, signature: signBip322Simple(priv, 'p2tr', ch.message), address }) });
  expect(v.status).toBe(200);
  const { token } = (await v.json()) as { token: string };
  const bytes = squareArt();
  const created = await app.request('/v1/artworks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ title: 'wired', contentType: 'image/jpeg', contentLength: bytes.length }) });
  expect(created.status).toBe(201);
  const { artwork, uploadToken } = (await created.json()) as { artwork: { id: string }; uploadToken: string };
  const up = await app.request(`/v1/artworks/${artwork.id}/content`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${uploadToken}` }, body: bytes as unknown as BodyInit });
  expect(up.status).toBe(200);
  const afterUpload = (await up.json()) as { status: string; needsHuman: boolean };
  // No vision key: the design rules need a human.
  expect(afterUpload).toMatchObject({ status: 'reviewing', needsHuman: true });
  const reviewed = await app.request(`/v1/artworks/${artwork.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': reviewerKey }, body: JSON.stringify({ decision: 'approve' }) });
  expect(reviewed.status).toBe(200);
  const content = await app.request(`/v1/artworks/${artwork.id}/content`);
  expect(content.status).toBe(200);
  expect(content.headers.get('content-type')).toBe('image/jpeg');
  return artwork.id;
}

describe('buildRuntime', () => {
  it('regtest with in-memory defaults generates dev keys and serves the whole flow', async () => {
    const rt = buildRuntime(loadConfig({ NETWORK: 'regtest' }), silentLogger);
    expect(rt.devApiKeys.map((k) => k.id)).toEqual(['dev-reviewer', 'dev-mint']);
    expect(rt.service.settings.visionReview).toBe('none');
    const health = (await (await rt.app.request('/v1/health')).json()) as { status: string; checks: { review: { detail: string } } };
    expect(health.status).toBe('ok');
    expect(health.checks.review.detail).toBe('rules+vision');
    await roundTrip(rt.app, rt.devApiKeys[0]!.key);
    expect(rt.events.events.map((e) => e.status)).toEqual(['submitted', 'reviewing', 'approved']);
    rt.close();
  });

  it('sqlite + filesystem content + configured keys, and state survives a rebuild', async () => {
    const k = generateApiKey('test');
    const env = {
      NETWORK: 'regtest',
      DATABASE_PATH: join(dir, 'studio.db'),
      CONTENT_DIR: join(dir, 'content'),
      SESSION_SIGNING_KEY: '11'.repeat(32),
      API_KEYS: JSON.stringify([{ id: 'house', hash: hashApiKey(k.key), scopes: ['studio:review'] }]),
    };
    const rt = buildRuntime(loadConfig(env), silentLogger);
    expect(rt.devApiKeys).toEqual([]);
    const id = await roundTrip(rt.app, k.key);
    rt.close();
    const rt2 = buildRuntime(loadConfig(env), silentLogger);
    const r = await rt2.app.request(`/v1/artworks/${id}`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe('approved');
    expect((await rt2.app.request(`/v1/artworks/${id}/content`)).status).toBe(200);
    rt2.close();
  });

  it('a vision key wires the Claude reviewer (constructed, never called here)', () => {
    const rt = buildRuntime(loadConfig({ NETWORK: 'regtest', VISION_REVIEW_API_KEY: 'sk-ant-test' }), silentLogger);
    expect(rt.service.settings.visionReview).toBe('claude');
    rt.close();
  });

  it('refuses to start off regtest without a session key', () => {
    const cfg = loadConfig({ NETWORK: 'regtest' });
    cfg.settings.network = 'signet';
    expect(() => buildRuntime(cfg, silentLogger)).toThrow(/SESSION_SIGNING_KEY/);
  });
});
