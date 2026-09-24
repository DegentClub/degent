/** The HTTP layer: status mapping, no invite leakage, CORS, body limits, operator auth (ported from gate-server tests). */
import { describe, expect, it } from 'vitest';
import { makeGate, post, WEB, linkFor, wallet } from './helpers.js';

describe('HTTP API', () => {
  it('GET /gate/health', async () => {
    const g = makeGate();
    const res = await g.app.request('/gate/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('challenge -> sign -> verify over HTTP; the invite link never reaches the browser', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [17] } });
    const token = await linkFor(g, 42);
    const chRes = await post(g, '/gate/challenge', { token, address: w.address }, { origin: WEB });
    expect(chRes.status).toBe(200);
    expect(chRes.headers.get('access-control-allow-origin')).toBe(WEB);
    const ch = (await chRes.json()) as { message: string; expiresAt: string };
    const res = await post(g, '/gate/verify', { token, address: w.address, message: ch.message, signature: w.sign(ch.message) }, { origin: WEB });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, degents: [17] });
    expect(text).not.toContain('t.me');
    expect(g.telegram.messages[0]!.text).toContain('t.me');
  });

  it('maps GateError to its status and a structured body', async () => {
    const w = wallet(1);
    const g = makeGate();
    const token = await linkFor(g, 42);
    const ch = (await (await post(g, '/gate/challenge', { token, address: w.address })).json()) as { message: string };
    const res = await post(g, '/gate/verify', { token, address: w.address, message: ch.message, signature: w.sign(ch.message) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'not_a_holder', message: 'this address does not hold a Degent' } });
  });

  it('validates the body', async () => {
    const g = makeGate();
    const res = await post(g, '/gate/verify', { token: 't' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
  });

  it('requires JSON and a JSON body', async () => {
    const g = makeGate();
    const plain = await g.app.request('/gate/challenge', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    expect(plain.status).toBe(415);
    const broken = await g.app.request('/gate/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(broken.status).toBe(400);
  });

  it('refuses bodies over 16 KiB', async () => {
    const g = makeGate();
    const res = await post(g, '/gate/challenge', { token: 'x', address: 'y'.repeat(20_000) });
    expect(res.status).toBe(413);
  });

  it('hides internal errors', async () => {
    const g = makeGate();
    (g.service as unknown as { challenge: () => never }).challenge = () => {
      throw new Error('db exploded');
    };
    const res = await post(g, '/gate/challenge', { token: 't', address: 'a' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('exploded');
  });

  it('only allows the web origin (CORS preflight and POSTs)', async () => {
    const g = makeGate();
    const evil = await g.app.request('/gate/verify', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const good = await g.app.request('/gate/verify', { method: 'OPTIONS', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
    expect(good.headers.get('access-control-allow-origin')).toBe(WEB);
    const forbidden = await post(g, '/gate/challenge', { token: 't', address: 'a' }, { origin: 'https://evil.example' });
    expect(forbidden.status).toBe(403);
  });

  it('rate limits POSTs per client IP', async () => {
    const g = makeGate();
    const { createApp } = await import('../src/app.js');
    const app = createApp({ service: g.service, corsOrigins: [WEB], rateLimit: { windowMs: 60_000, max: 2 }, trustProxy: true, now: g.now });
    const hit = (ip: string) => app.request('/gate/challenge', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}' });
    expect((await hit('1.1.1.1')).status).toBe(400);
    expect((await hit('1.1.1.1')).status).toBe(400);
    const limited = await hit('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await hit('2.2.2.2')).status).toBe(400);
  });

  it('GET /gate/stats requires an operator session', async () => {
    const admin = wallet(500);
    const g = makeGate({ settings: { adminAddresses: [admin.address] } });
    expect((await g.app.request('/gate/stats')).status).toBe(401);
    expect((await g.app.request('/gate/stats', { headers: { authorization: 'Bearer nope-nope-nope-nope' } })).status).toBe(401);
    const ch = (await (await post(g, '/gate/admin/challenge', { address: admin.address })).json()) as { message: string };
    const s = (await (await post(g, '/gate/admin/verify', { address: admin.address, message: ch.message, signature: admin.sign(ch.message) })).json()) as { token: string };
    const ok = await g.app.request('/gate/stats', { headers: { authorization: `Bearer ${s.token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ activeMembers: 0, revokedMembers: 0, degentsHeld: 0, invitesIssued: 0, kickPending: 0, lastReverify: null });
  });

  it('unknown routes are structured 404s', async () => {
    const g = makeGate();
    const res = await g.app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'no such endpoint' } });
  });
});
