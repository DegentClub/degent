import { describe, it, expect, vi } from 'vitest';
import { createHolderClient } from '../src/telegram-gate/holders';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function setup(responses, extra = {}) {
  let t = 1_000_000;
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps = [];
  const client = createHolderClient({
    baseUrl: 'https://register.example/',
    fetch,
    now: () => t,
    sleep: async (ms) => sleeps.push(ms),
    backoffMs: 100,
    retries: 3,
    cacheTtlMs: 5 * 60 * 1000,
    ...extra,
  });
  return { client, fetch, sleeps, advance: (ms) => (t += ms) };
}

describe('holder client', () => {
  it('calls the documented endpoint and returns holds', async () => {
    const { client, fetch } = setup([jsonResponse(200, { holds: [12, 340] })]);
    expect(await client.getHoldings('bc1qabc')).toEqual([12, 340]);
    expect(fetch).toHaveBeenCalledWith('https://register.example/api/register/holder/bc1qabc', expect.anything());
  });

  it('caches for 5 minutes, case-insensitively', async () => {
    const { client, fetch, advance } = setup([jsonResponse(200, { holds: [1] }), jsonResponse(200, { holds: [] })]);
    await client.getHoldings('bc1qabc');
    await client.getHoldings('BC1QABC');
    advance(4 * 60 * 1000);
    expect(await client.getHoldings('bc1qabc')).toEqual([1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(2 * 60 * 1000);
    expect(await client.getHoldings('bc1qabc')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache with fresh: true', async () => {
    const { client, fetch } = setup([jsonResponse(200, { holds: [1] }), jsonResponse(200, { holds: [] })]);
    await client.getHoldings('a');
    expect(await client.getHoldings('a', { fresh: true })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats 404 as "holds nothing"', async () => {
    const { client } = setup([jsonResponse(404, { error: 'no' })]);
    expect(await client.getHoldings('a')).toEqual([]);
    expect(await client.holds('a')).toBe(false);
  });

  it('retries 5xx and network errors with exponential backoff', async () => {
    const { client, fetch, sleeps } = setup([
      jsonResponse(503, {}),
      new Error('ECONNRESET'),
      jsonResponse(200, { holds: [7] }),
    ]);
    expect(await client.getHoldings('a')).toEqual([7]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('gives up after the configured retries', async () => {
    const { client, fetch } = setup([jsonResponse(500, {}), jsonResponse(500, {}), jsonResponse(500, {}), jsonResponse(500, {})]);
    await expect(client.getHoldings('a')).rejects.toThrow(/500/);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry 4xx other than 429', async () => {
    const { client, fetch } = setup([jsonResponse(400, {})]);
    await expect(client.getHoldings('a')).rejects.toThrow(/400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed body', async () => {
    const { client } = setup([jsonResponse(200, { nope: true }), jsonResponse(200, { nope: true }), jsonResponse(200, { nope: true }), jsonResponse(200, { nope: true })]);
    await expect(client.getHoldings('a')).rejects.toThrow(/holds/);
  });

  it('drops non-integer entries', async () => {
    const { client } = setup([jsonResponse(200, { holds: [1, '2', null, 3.5, 4] })]);
    expect(await client.getHoldings('a')).toEqual([1, 4]);
  });
});
