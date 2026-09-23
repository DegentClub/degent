import { describe, expect, it } from 'vitest';
import { InMemoryNonceStore } from '../src/index.js';

const b = { domain: 'example.com', address: 'bc1qexample' };

describe('InMemoryNonceStore', () => {
  it('consumes an issued nonce exactly once', async () => {
    const s = new InMemoryNonceStore();
    await s.issue({ nonce: 'n1', expiresAt: Date.now() + 60_000, ...b });
    expect(await s.consume('n1', b, Date.now())).toBe('ok');
    expect(await s.consume('n1', b, Date.now())).toBe('replayed');
  });

  it('reports unknown, expired and binding mismatches', async () => {
    const s = new InMemoryNonceStore();
    const now = Date.now();
    await s.issue({ nonce: 'n2', expiresAt: now + 1000, ...b });
    expect(await s.consume('nope', b, now)).toBe('unknown');
    expect(await s.consume('n2', { ...b, domain: 'evil.com' }, now)).toBe('unknown');
    expect(await s.consume('n2', { ...b, address: 'bc1qother' }, now)).toBe('unknown');
    expect(await s.consume('n2', b, now + 1000)).toBe('expired');
  });

  it('refuses duplicate issuance and enforces a size cap', async () => {
    const s = new InMemoryNonceStore({ maxEntries: 2 });
    const exp = Date.now() + 60_000;
    await s.issue({ nonce: 'a', expiresAt: exp, ...b });
    await expect(s.issue({ nonce: 'a', expiresAt: exp, ...b })).rejects.toThrow(/already/);
    await s.issue({ nonce: 'b', expiresAt: exp, ...b });
    await expect(s.issue({ nonce: 'c', expiresAt: exp, ...b })).rejects.toThrow(/full/);
  });

  it('sweeps entries past expiry + retention', async () => {
    const s = new InMemoryNonceStore({ retainMs: 10 });
    const now = Date.now();
    await s.issue({ nonce: 'x', expiresAt: now + 5, ...b });
    s.sweep(now + 10);
    expect(s.size).toBe(1);
    s.sweep(now + 15);
    expect(s.size).toBe(0);
  });

  it('is race-safe under concurrent consumers', async () => {
    const s = new InMemoryNonceStore();
    await s.issue({ nonce: 'race', expiresAt: Date.now() + 60_000, ...b });
    const results = await Promise.all(Array.from({ length: 20 }, () => s.consume('race', b, Date.now())));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
  });
});
