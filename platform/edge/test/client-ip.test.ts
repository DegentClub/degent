import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cidrContains, formatIp, getClientIp, parseCidr, parseIp, trustProxy } from '../src/index.js';
import { peer } from './helpers.js';

describe('IP parsing', () => {
  it.each([
    ['1.2.3.4', 4, '1.2.3.4'],
    ['::1', 6, '0:0:0:0:0:0:0:1'],
    ['2001:db8::8a2e:370:7334', 6, '2001:db8:0:0:0:8a2e:370:7334'],
    ['::ffff:10.0.0.1', 4, '10.0.0.1'],
    ['[2001:db8::1]', 6, '2001:db8:0:0:0:0:0:1'],
    ['fe80::1%eth0', 6, 'fe80:0:0:0:0:0:0:1'],
    ['::', 6, '0:0:0:0:0:0:0:0'],
    ['64:ff9b::192.0.2.33', 6, '64:ff9b:0:0:0:0:c000:221'],
  ])('%s', (s, v, f) => {
    const p = parseIp(s)!;
    expect(p.version).toBe(v);
    expect(formatIp(p)).toBe(f);
  });

  it.each(['', '1.2.3', '1.2.3.256', '01.2.3.4', '1.2.3.4.5', 'a::b::c', '12345::', 'evil', '1:2:3:4:5:6:7:8:9', 'unknown'])(
    'rejects %s',
    (s) => expect(parseIp(s)).toBeUndefined(),
  );

  it('CIDR membership', () => {
    expect(cidrContains(parseCidr('10.0.0.0/8'), parseIp('10.200.1.1')!)).toBe(true);
    expect(cidrContains(parseCidr('10.0.0.0/8'), parseIp('11.0.0.1')!)).toBe(false);
    expect(cidrContains(parseCidr('10.0.0.0/8'), parseIp('::ffff:10.1.1.1')!)).toBe(true);
    expect(cidrContains(parseCidr('fd00::/8'), parseIp('fd12::1')!)).toBe(true);
    expect(cidrContains(parseCidr('fd00::/8'), parseIp('10.0.0.1')!)).toBe(false);
    expect(cidrContains(parseCidr('192.168.1.7'), parseIp('192.168.1.7')!)).toBe(true);
    expect(cidrContains(parseCidr('0.0.0.0/0'), parseIp('8.8.8.8')!)).toBe(true);
    for (const bad of ['10.0.0.0/33', '10.0.0.0/-1', 'x/8', '10.0.0.0/8/9', '10.0.0.0/08x']) expect(() => parseCidr(bad)).toThrow();
  });
});

function app(mw?: ReturnType<typeof trustProxy>) {
  const a = new Hono();
  if (mw) a.use(mw);
  a.get('/', (c) => c.text(getClientIp(c)));
  return a;
}
const req = (a: Hono, xff: string | undefined, remote: string) =>
  Promise.resolve(a.request('/', { headers: xff === undefined ? {} : { 'X-Forwarded-For': xff } }, peer(remote))).then((r) => r.text());

describe('client IP / trustProxy', () => {
  it('ignores X-Forwarded-For unless configured', async () => {
    expect(await req(app(), '6.6.6.6', '203.0.113.9')).toBe('203.0.113.9');
    expect(await Promise.resolve(app().request('/')).then((r) => r.text())).toBe('unknown');
  });

  it('hops: picks the entry our proxies appended', async () => {
    const a = app(trustProxy({ hops: 1 }));
    expect(await req(a, '198.51.100.7', '10.0.0.2')).toBe('198.51.100.7');
    // client-spoofed leftmost entries are ignored
    expect(await req(a, '6.6.6.6, 198.51.100.7', '10.0.0.2')).toBe('198.51.100.7');
    const two = app(trustProxy({ hops: 2 }));
    expect(await req(two, '6.6.6.6, 198.51.100.7, 10.0.0.5', '10.0.0.2')).toBe('198.51.100.7');
    // header missing: fall back to the peer
    expect(await req(a, undefined, '10.0.0.2')).toBe('10.0.0.2');
    // garbage hop: fall back to the nearest valid hop
    expect(await req(a, 'not-an-ip', '10.0.0.2')).toBe('10.0.0.2');
  });

  it('trusted: only honoured when the peer is a trusted proxy', async () => {
    const a = app(trustProxy({ trusted: ['10.0.0.0/8', 'fd00::/8'] }));
    expect(await req(a, '198.51.100.7', '10.1.2.3')).toBe('198.51.100.7');
    expect(await req(a, '6.6.6.6, 198.51.100.7, 10.9.9.9', '10.1.2.3')).toBe('198.51.100.7');
    expect(await req(a, '198.51.100.7', '203.0.113.50')).toBe('203.0.113.50'); // untrusted peer: XFF ignored
    expect(await req(a, '10.0.0.8, 10.0.0.9', '10.1.2.3')).toBe('10.0.0.8'); // all trusted: leftmost
    expect(await req(a, '2001:db8::7', 'fd00::1')).toBe('2001:db8:0:0:0:0:0:7');
    expect(await req(a, 'garbage', '10.1.2.3')).toBe('10.1.2.3');
  });

  it('validates its configuration', () => {
    expect(() => trustProxy({})).toThrow();
    expect(() => trustProxy({ hops: 1, trusted: ['10.0.0.0/8'] })).toThrow();
    expect(() => trustProxy({ hops: 0 })).toThrow();
    expect(() => trustProxy({ trusted: ['nope'] })).toThrow();
  });
});
