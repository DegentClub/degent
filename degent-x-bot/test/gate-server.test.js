import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mockRequire, requireFresh, nodeRequire } from './helpers/mock-require';

// Same module instance the server sees (native require), so instanceof holds.
const { GateError } = nodeRequire('../src/telegram-gate/service');

mockRequire('../src/lib/logger', { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
const { buildGateServer } = requireFresh('../src/telegram-gate/server');

const config = {
  admin: { jwtSecret: 'a'.repeat(40) },
  gate: { webBaseUrl: 'https://degent.club' },
};

const service = {
  challenge: vi.fn(async () => ({ message: 'm', nonce: 'n', expires: 'e' })),
  verify: vi.fn(async () => ({ ok: true, inviteLink: 'https://t.me/+secret', degents: [1] })),
  stats: vi.fn(async () => ({ activeMembers: 1 })),
};

let app;
beforeAll(async () => {
  app = await buildGateServer({ service, config, logger: { error: vi.fn() } });
  await app.ready();
});
afterAll(() => app.close());

describe('gate server', () => {
  it('POST /gate/challenge forwards to the service', async () => {
    const res = await app.inject({ method: 'POST', url: '/gate/challenge', payload: { token: 't', address: 'a' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'm', nonce: 'n', expires: 'e' });
  });

  it('POST /gate/verify never leaks the invite link to the browser', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gate/verify',
      payload: { token: 't', address: 'a', message: 'm', signature: 's'.repeat(30) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, degents: [1] });
    expect(res.body).not.toContain('t.me');
  });

  it('validates the body', async () => {
    const res = await app.inject({ method: 'POST', url: '/gate/verify', payload: { token: 't' } });
    expect(res.statusCode).toBe(400);
  });

  it('maps GateError to its status and code', async () => {
    service.verify.mockRejectedValueOnce(new GateError('not_a_holder', 'no', 403));
    const res = await app.inject({
      method: 'POST',
      url: '/gate/verify',
      payload: { token: 't', address: 'a', message: 'm', signature: 's'.repeat(30) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_a_holder', message: 'no' });
  });

  it('hides internal errors', async () => {
    service.challenge.mockRejectedValueOnce(new Error('db exploded'));
    const res = await app.inject({ method: 'POST', url: '/gate/challenge', payload: { token: 't', address: 'a' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('exploded');
  });

  it('GET /gate/stats requires an admin JWT', async () => {
    expect((await app.inject({ method: 'GET', url: '/gate/stats' })).statusCode).toBe(401);
    const token = app.jwt.sign({ username: 'admin', role: 'admin' });
    const ok = await app.inject({ method: 'GET', url: '/gate/stats', headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ activeMembers: 1 });
  });

  it('only allows the web origin for CORS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/gate/verify',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const good = await app.inject({
      method: 'OPTIONS',
      url: '/gate/verify',
      headers: { origin: 'https://degent.club', 'access-control-request-method': 'POST' },
    });
    expect(good.headers['access-control-allow-origin']).toBe('https://degent.club');
  });
});
