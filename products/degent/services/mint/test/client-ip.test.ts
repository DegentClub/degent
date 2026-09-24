/**
 * DGT-SEC-007: behind the proxy (TRUST_PROXY=true) the rate-limit key must be an address the client cannot
 * choose. The left-most X-Forwarded-For entry is whatever the client sent; the proxy's own view is the
 * X-Client-IP header our Caddy site sets from {client_ip}, or failing that the right-most XFF entry.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { StaticFees } from '../src/adapters/fees.js';
import { makeHarness } from './fakes/harness.js';

function proxiedApp(max: number) {
  const h = makeHarness();
  const fees = new StaticFees({ standard: { slow: 1, normal: 2, fast: 5 }, block: { min: 1, recommended: 3 } }, () => h.clock.now());
  const app = createApp({
    orders: h.orders,
    approval: h.approval,
    register: h.register,
    fees,
    clock: h.clock,
    corsOrigins: [],
    rateLimit: { windowMs: 60_000, max },
    trustProxy: true,
  });
  const post = (headers: Record<string, string>) =>
    app.request('/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  return { post };
}

describe('DGT-SEC-007: client IP behind the proxy', () => {
  it('a client rotating a spoofed left-most X-Forwarded-For is still one client', async () => {
    const { post } = proxiedApp(2);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post({ 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` })).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it('prefers the X-Client-IP header the proxy sets (Caddy {client_ip})', async () => {
    const { post } = proxiedApp(1);
    expect((await post({ 'x-client-ip': '198.51.100.1', 'x-forwarded-for': '1.1.1.1, 172.18.0.5' })).status).not.toBe(429);
    expect((await post({ 'x-client-ip': '198.51.100.1', 'x-forwarded-for': '2.2.2.2, 172.18.0.5' })).status).toBe(429);
    expect((await post({ 'x-client-ip': '198.51.100.2', 'x-forwarded-for': '2.2.2.2, 172.18.0.5' })).status).not.toBe(429);
  });
});
