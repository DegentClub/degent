/**
 * The /verify page's gate client against contracts/openapi/degent-telegram-gate.yaml (provided by
 * @bsh/degent-telegram-gate): paths, methods, request bodies (exact field sets) and error mapping. The service
 * side of the same contract is asserted in products/degent/services/telegram-gate/test/contract.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createRealGate, GATE_CHALLENGE_PATH, GATE_VERIFY_PATH } from '../src/services/real/gate';
import { readGateToken } from '../src/screens/Verify';

// vitest runs from the package directory (jsdom rewrites import.meta.url to /@fs/…)
const root = join(process.cwd(), '../../../..');
const openapi = parse(readFileSync(join(root, 'contracts/openapi/degent-telegram-gate.yaml'), 'utf8'));
const schemas = openapi.components.schemas;
const deref = (s: { $ref?: string }) => (s.$ref ? schemas[s.$ref.split('/').pop()!] : s);

function capture(status = 200, reply: unknown = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, gate: createRealGate(fetchImpl) };
}

function conforms(body: Record<string, unknown>, schemaRef: { $ref?: string }): string[] {
  const s = deref(schemaRef);
  const errs: string[] = [];
  for (const k of s.required ?? []) if (!(k in body)) errs.push(`missing ${k}`);
  for (const [k, v] of Object.entries(body)) {
    const p = s.properties?.[k];
    if (!p) errs.push(`${k} not in contract`);
    else {
      const ps = deref(p);
      if (ps.type === 'string' && typeof v !== 'string') errs.push(`${k} not a string`);
      if (ps.pattern && typeof v === 'string' && !new RegExp(ps.pattern).test(v)) errs.push(`${k} pattern`);
    }
  }
  return errs;
}

const reqSchema = (path: string) => openapi.paths[path].post.requestBody.content['application/json'].schema;

describe('/verify page <-> degent-telegram-gate contract', () => {
  it('the page posts to paths the contract defines', () => {
    expect(openapi.paths[GATE_CHALLENGE_PATH]?.post).toBeDefined();
    expect(openapi.paths[GATE_VERIFY_PATH]?.post).toBeDefined();
  });

  it('challenge: POST {token, address} to <VITE_GATE_URL>/gate/challenge', async () => {
    const { calls, gate } = capture(200, { message: 'm', expiresAt: '2026-09-24T12:10:00.000Z' });
    const r = await gate.challenge('https://gate.degent.club', { token: 'AbC_defgh-123456', address: 'bc1pexample' });
    expect(r).toEqual({ ok: true, message: 'm', expiresAt: '2026-09-24T12:10:00.000Z' });
    expect(calls[0]).toMatchObject({ url: 'https://gate.degent.club/gate/challenge', method: 'POST' });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(conforms(calls[0]!.body as Record<string, unknown>, reqSchema(GATE_CHALLENGE_PATH))).toEqual([]);
  });

  it('verify: POST exactly {token, address, message, signature} to <VITE_GATE_URL>/gate/verify', async () => {
    const { calls, gate } = capture(200, { ok: true, degents: [4113], message: 'Verified.' });
    const body = { token: 'AbC_defgh-123456', address: 'bc1pexample', message: 'signed text', signature: 'c2lnbmF0dXJl' };
    const r = await gate.submit('https://gate.degent.club', body);
    expect(r).toEqual({ ok: true, degents: [4113], message: 'Verified.' });
    expect(calls[0]).toMatchObject({ url: 'https://gate.degent.club/gate/verify', method: 'POST' });
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual([...deref(reqSchema(GATE_VERIFY_PATH)).required].sort());
    expect(conforms(calls[0]!.body as Record<string, unknown>, reqSchema(GATE_VERIFY_PATH))).toEqual([]);
  });

  it('surfaces the contract error body `{error: {code, message}}` as the message', async () => {
    const { gate } = capture(409, { error: { code: 'address_taken', message: 'this wallet is already linked to another Telegram account' } });
    expect(await gate.submit('https://g', { token: 't', address: 'a', message: 'm', signature: 's' })).toEqual({
      ok: false,
      message: 'this wallet is already linked to another Telegram account',
    });
    expect(schemas.ErrorCode.enum).toContain('address_taken');
  });

  it('a network failure is a refusal, not a crash', async () => {
    const gate = createRealGate((async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(await gate.challenge('https://g', { token: 't', address: 'a' })).toEqual({ ok: false, message: 'Failed to fetch' });
  });

  it('readGateToken accepts exactly the LinkToken pattern', () => {
    const pattern = new RegExp(schemas.LinkToken.pattern);
    for (const t of ['AbCdEfGh', 'a'.repeat(50), 'x_y-z12345', 'a'.repeat(128)]) {
      expect(pattern.test(t)).toBe(true);
      expect(readGateToken(`?tg=${t}`)).toBe(t);
    }
    for (const t of ['short', 'a.b.c.d.e.f', 'a'.repeat(129), 'bad token']) {
      expect(pattern.test(t)).toBe(false);
      expect(readGateToken(`?tg=${encodeURIComponent(t)}`)).toBeNull();
    }
  });
});
