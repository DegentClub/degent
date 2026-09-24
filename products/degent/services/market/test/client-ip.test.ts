/** DGT-SEC-007: the rate-limit key behind the proxy is never the client-supplied left-most X-Forwarded-For hop. */
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIpOf } from '../src/app.js';

const ctx = (headers: Record<string, string>, remote = '172.18.0.9') =>
  ({ req: { header: (n: string) => headers[n.toLowerCase()] }, env: { incoming: { socket: { remoteAddress: remote } } } }) as unknown as Context;

describe('DGT-SEC-007: clientIpOf', () => {
  it('behind the proxy: X-Client-IP, else the right-most X-Forwarded-For hop, else the socket', () => {
    const ip = clientIpOf(true);
    expect(ip(ctx({ 'x-client-ip': '198.51.100.1', 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('198.51.100.1');
    expect(ip(ctx({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('203.0.113.7');
    expect(ip(ctx({ 'x-client-ip': 'not an ip', 'x-forwarded-for': 'junk' }))).toBe('172.18.0.9');
    expect(ip(ctx({}))).toBe('172.18.0.9');
  });

  it('without a trusted proxy the headers are ignored', () => {
    expect(clientIpOf(false)(ctx({ 'x-client-ip': '198.51.100.1', 'x-forwarded-for': '6.6.6.6' }))).toBe('172.18.0.9');
  });
});
