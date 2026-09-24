import { describe, expect, it } from 'vitest';
import { HttpXClient } from '../src/adapters/http-x-client.js';

describe('HttpXClient', () => {
  it('POSTs {text} to /2/tweets with the bearer token and returns the id', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const x = new HttpXClient({
      accessToken: 'tok',
      fetch: async (url, init) => {
        calls.push({ url, init: init! });
        return new Response(JSON.stringify({ data: { id: '1800', text: 'gm.' } }), { status: 201 });
      },
    });
    expect(await x.post('gm.')).toEqual({ id: '1800' });
    expect(calls[0]!.url).toBe('https://api.x.com/2/tweets');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'gm.' });
  });

  it('surfaces API errors without echoing the token', async () => {
    const x = new HttpXClient({ accessToken: 'secret-token', fetch: async () => new Response(JSON.stringify({ title: 'Forbidden', detail: 'duplicate content' }), { status: 403 }) });
    const err = await x.post('gm.').catch((e: Error) => e);
    expect(String(err)).toMatch(/403: duplicate content/);
    expect(String(err)).not.toContain('secret-token');
  });

  it('requires a token', () => {
    expect(() => new HttpXClient({ accessToken: '' })).toThrow();
  });
});
