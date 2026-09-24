/**
 * The gate's behaviour, ported from Degent-X-Bot's gate-service tests onto @bsh/identity (SIWB + BIP-322 with keys
 * generated in the test): one-time links, challenge single use and expiry, one wallet <-> one Telegram account,
 * exactly one invite per verification, re-verification keeps holders and kicks sellers, operator sessions.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { parseSiwbMessage } from '@bsh/identity';
import { GateError } from '../src/domain/errors.js';
import { gateStatement } from '../src/domain/statement.js';
import { CHAT, T0, WEB, linkFor, makeGate, verifyFlow, wallet, type Gate } from './helpers.js';

describe('startVerification (/verify in a DM)', () => {
  it('returns a one-time link on the web base URL with a token for that user', async () => {
    const g = makeGate();
    const { url, text, token } = await g.service.startVerification(99);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${WEB}/verify`);
    expect(u.searchParams.get('tg')).toBe(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(text).toContain(url);
    expect(text).toContain('10 minutes');
  });

  it('rate limits /verify to 3 per 10 minutes per Telegram user', async () => {
    const g = makeGate();
    for (let i = 0; i < 3; i++) await g.service.startVerification(5);
    await expect(g.service.startVerification(5)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(g.service.startVerification(6)).resolves.toBeTruthy(); // other users unaffected
    g.advance(10 * 60 * 1000 + 1);
    await expect(g.service.startVerification(5)).resolves.toBeTruthy();
  });

  it.each([0, -1, 1.5, 'x', null, undefined, Number.MAX_SAFE_INTEGER + 2])('rejects the Telegram id %j', async (id) => {
    const g = makeGate();
    await expect(g.service.startVerification(id)).rejects.toBeInstanceOf(GateError);
  });
});

describe('challenge (POST /gate/challenge)', () => {
  it('issues a SIWB challenge bound to the domain, the address and the link\'s Telegram user', async () => {
    const g = makeGate();
    const w = wallet(1);
    const token = await linkFor(g, 11);
    const ch = await g.service.challenge({ token, address: w.address });
    const f = parseSiwbMessage(ch.message);
    expect(f.domain).toBe('degent.club');
    expect(f.uri).toBe(WEB);
    expect(f.address).toBe(w.address);
    expect(f.network).toBe('mainnet');
    expect(f.statement).toBe(gateStatement(11));
    expect(ch.expiresAt).toBe(new Date(T0 + 600_000).toISOString());
    const ch2 = await g.service.challenge({ token, address: w.address });
    expect(parseSiwbMessage(ch2.message).nonce).not.toBe(f.nonce);
  });

  it('never outlives the link it came from', async () => {
    const g = makeGate();
    const token = await linkFor(g, 11);
    g.advance(8 * 60 * 1000);
    const ch = await g.service.challenge({ token, address: wallet(1).address });
    expect(Date.parse(ch.expiresAt)).toBe(T0 + 600_000);
  });

  it('rejects an expired or forged link token', async () => {
    const g = makeGate();
    const w = wallet(1);
    const token = await linkFor(g, 11);
    g.advance(11 * 60 * 1000);
    await expect(g.service.challenge({ token, address: w.address })).rejects.toMatchObject({ code: 'bad_token', status: 401 });
    await expect(g.service.challenge({ token: 'a'.repeat(50), address: w.address })).rejects.toMatchObject({ code: 'bad_token' });
    await expect(g.service.challenge({ token: 'a.b.c', address: w.address })).rejects.toMatchObject({ code: 'bad_token' });
  });

  it.each(['0xdeadbeef', 'bc1qshort', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', ' bc1q'])('rejects the address %j', async (address) => {
    const g = makeGate();
    const token = await linkFor(g, 11);
    await expect(g.service.challenge({ token, address })).rejects.toMatchObject({ code: 'bad_address', status: 400 });
  });

  it('rejects a body without token or address', async () => {
    const g = makeGate();
    await expect(g.service.challenge({ address: wallet(1).address })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(g.service.challenge(null)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(g.service.challenge([])).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('verify (POST /gate/verify)', () => {
  it('happy path: verifies, stores the member, issues exactly one invite and DMs it', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [101, 202] } });
    const { result } = await verifyFlow(g, 42, w);

    expect(result).toEqual({ ok: true, degents: [101, 202], message: expect.stringContaining('Telegram DMs') });
    expect(JSON.stringify(result)).not.toContain('t.me');

    expect(g.telegram.invites).toHaveLength(1);
    expect(g.telegram.invites[0]).toMatchObject({ chatId: CHAT, opts: { memberLimit: 1, name: 'gate:42' } });
    expect(g.telegram.invites[0]!.opts.expireDate * 1000).toBe(T0 + 10 * 60 * 1000);

    expect(g.telegram.messages).toHaveLength(1);
    expect(g.telegram.messages[0]!.chatId).toBe(42);
    expect(g.telegram.messages[0]!.text).toContain('https://t.me/+invite1');
    expect(g.telegram.messages[0]!.text).toContain('2 Degents');

    const m = await g.members.findByTelegramId(42);
    expect(m).toMatchObject({ address: w.address, degents: [101, 202], status: 'active', invitesIssued: 1 });
    expect(m!.inviteIssuedAt).toBe(new Date(T0).toISOString());
    expect(g.holders.calls).toContainEqual({ address: w.address, fresh: true });
  });

  it.each([
    ['taproot (BIP-322)', 'tr'],
    ['native segwit (BIP-322)', 'wpkh'],
    ['legacy P2PKH (signmessage)', 'pkh'],
  ] as const)('accepts a %s wallet', async (_label, kind) => {
    const w = wallet(7, kind);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const { result } = await verifyFlow(g, 43, w);
    expect(result.ok).toBe(true);
  });

  it('a challenge is single use', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const { ch, signature } = await verifyFlow(g, 42, w);
    const token2 = await linkFor(g, 42);
    await expect(g.service.verify({ token: token2, address: w.address, message: ch.message, signature })).rejects.toMatchObject({
      code: 'auth_failed',
      status: 401,
      message: expect.stringContaining('nonce_replayed'),
    });
    expect(g.telegram.invites).toHaveLength(1); // still exactly one
  });

  it('a link is single use (a second challenge on the same link cannot verify again)', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const { token } = await verifyFlow(g, 42, w);
    const ch = await g.service.challenge({ token, address: w.address });
    await expect(g.service.verify({ token, address: w.address, message: ch.message, signature: w.sign(ch.message) })).rejects.toMatchObject({
      code: 'bad_token',
    });
    expect(g.telegram.invites).toHaveLength(1);
  });

  it('a challenge expires with its link', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const token = await linkFor(g, 42);
    const ch = await g.service.challenge({ token, address: w.address });
    const signature = w.sign(ch.message);
    g.advance(11 * 60 * 1000);
    await expect(g.service.verify({ token, address: w.address, message: ch.message, signature })).rejects.toMatchObject({ status: 401 });
    expect(g.telegram.invites).toHaveLength(0);
  });

  it('rejects a signature by another key', async () => {
    const w = wallet(1);
    const other = wallet(2);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const token = await linkFor(g, 42);
    const ch = await g.service.challenge({ token, address: w.address });
    await expect(g.service.verify({ token, address: w.address, message: ch.message, signature: other.sign(ch.message) })).rejects.toMatchObject({
      code: 'auth_failed',
      message: expect.stringContaining('invalid_signature'),
    });
    expect(g.telegram.invites).toHaveLength(0);
  });

  it('a failed signature does not burn the challenge', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const token = await linkFor(g, 42);
    const ch = await g.service.challenge({ token, address: w.address });
    await expect(g.service.verify({ token, address: w.address, message: ch.message, signature: wallet(2).sign(ch.message) })).rejects.toBeInstanceOf(GateError);
    await expect(g.service.verify({ token, address: w.address, message: ch.message, signature: w.sign(ch.message) })).resolves.toMatchObject({ ok: true });
  });

  it('rejects a message for another Telegram account, even if validly signed', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const tokenA = await linkFor(g, 42);
    const tokenB = await linkFor(g, 43);
    const chB = await g.service.challenge({ token: tokenB, address: w.address });
    await expect(g.service.verify({ token: tokenA, address: w.address, message: chB.message, signature: w.sign(chB.message) })).rejects.toMatchObject({
      code: 'bad_message',
    });
    // ... and the challenge was not consumed by the refused attempt
    await expect(g.service.verify({ token: tokenB, address: w.address, message: chB.message, signature: w.sign(chB.message) })).resolves.toMatchObject({ ok: true });
  });

  it('rejects an altered message even with a valid signature over it', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const token = await linkFor(g, 42);
    const ch = await g.service.challenge({ token, address: w.address });
    const altered = ch.message.replace('Expiration Time: ', 'Expiration Time: 2099-01-01T00:00:00.000Z\nx: ');
    await expect(g.service.verify({ token, address: w.address, message: altered, signature: w.sign(altered) })).rejects.toMatchObject({ code: 'bad_message' });
  });

  it('a signer cannot stretch a challenge: the server-side nonce expiry wins over the signed Expiration Time', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const ch = await g.service.challenge({ token: await linkFor(g, 42), address: w.address });
    g.advance(11 * 60 * 1000);
    const fresh = await linkFor(g, 42);
    const retimed = ch.message.replace(/Expiration Time: .*/, 'Expiration Time: 2099-01-01T00:00:00.000Z');
    await expect(g.service.verify({ token: fresh, address: w.address, message: retimed, signature: w.sign(retimed) })).rejects.toMatchObject({
      code: 'auth_failed',
      message: expect.stringContaining('expired'),
    });
    expect(g.telegram.invites).toHaveLength(0);
  });

  it('rejects a message whose address differs from the claimed one', async () => {
    const w = wallet(1);
    const other = wallet(2);
    const g = makeGate({ holdings: { [w.address]: [1], [other.address]: [2] } });
    const token = await linkFor(g, 42);
    const ch = await g.service.challenge({ token, address: w.address });
    await expect(g.service.verify({ token, address: other.address, message: ch.message, signature: w.sign(ch.message) })).rejects.toMatchObject({
      code: 'bad_message',
    });
  });

  it('rejects a challenge issued for another domain', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const other = makeGate({ settings: { siwbDomain: 'evil.example', siwbUri: 'https://evil.example' } });
    const token = await linkFor(g, 42);
    const evilCh = await other.service.challenge({ token: await linkFor(other, 42), address: w.address });
    await expect(g.service.verify({ token, address: w.address, message: evilCh.message, signature: w.sign(evilCh.message) })).rejects.toMatchObject({
      code: 'auth_failed',
      message: expect.stringContaining('domain_mismatch'),
    });
  });

  it('rejects a non-holder without issuing an invite or storing a member', async () => {
    const w = wallet(1);
    const g = makeGate();
    await expect(verifyFlow(g, 42, w)).rejects.toMatchObject({ code: 'not_a_holder', status: 403 });
    expect(g.telegram.invites).toHaveLength(0);
    expect(await g.members.findByTelegramId(42)).toBeNull();
  });

  it('a Register failure is a 503, never an invite', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: new Error('register down') } });
    await expect(verifyFlow(g, 42, w)).rejects.toMatchObject({ code: 'upstream_unavailable', status: 503 });
    expect(g.telegram.invites).toHaveLength(0);
  });

  it('a Telegram error creating the invite is a 503 and records no invite', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    g.telegram.failNext('createInviteLink', 'Bad Request: not enough rights');
    await expect(verifyFlow(g, 42, w)).rejects.toMatchObject({ code: 'upstream_unavailable', status: 503 });
    expect((await g.members.findByTelegramId(42))?.invitesIssued).toBe(0);
  });

  it('when the DM fails the page is told to restart the bot (the invite is never returned instead)', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    g.telegram.failNext('sendMessage', 'Forbidden: bot was blocked by the user');
    const { result } = await verifyFlow(g, 42, w);
    expect(result.message).toMatch(/could not DM/);
    expect(JSON.stringify(result)).not.toContain('t.me');
  });
});

describe('one wallet <-> one Telegram account', () => {
  it('rejects a wallet already linked to another Telegram account, at challenge and at verify', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    await verifyFlow(g, 1, w);
    const token = await linkFor(g, 2);
    await expect(g.service.challenge({ token, address: w.address })).rejects.toMatchObject({ code: 'address_taken', status: 409 });
    expect(g.telegram.invites).toHaveLength(1);
  });

  it('checks again at verify (a race between two challenges)', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    const t1 = await linkFor(g, 1);
    const t2 = await linkFor(g, 2);
    const c1 = await g.service.challenge({ token: t1, address: w.address });
    const c2 = await g.service.challenge({ token: t2, address: w.address });
    await g.service.verify({ token: t1, address: w.address, message: c1.message, signature: w.sign(c1.message) });
    await expect(g.service.verify({ token: t2, address: w.address, message: c2.message, signature: w.sign(c2.message) })).rejects.toMatchObject({
      code: 'address_taken',
    });
    expect(g.telegram.invites).toHaveLength(1);
  });

  it('rejects a Telegram account already linked to another wallet, naming it', async () => {
    const w1 = wallet(1);
    const w2 = wallet(2);
    const g = makeGate({ holdings: { [w1.address]: [1], [w2.address]: [2] } });
    await verifyFlow(g, 1, w1);
    const token = await linkFor(g, 1);
    const err = await g.service.challenge({ token, address: w2.address }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'telegram_taken', status: 409 });
    expect((err as Error).message).toContain(w1.address);
  });

  it('lets the same pair re-verify (lost invite) and issues a new invite', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [1] } });
    await verifyFlow(g, 1, w);
    await verifyFlow(g, 1, w);
    expect(g.telegram.invites.map((i) => i.inviteLink)).toEqual(['https://t.me/+invite1', 'https://t.me/+invite2']);
    expect((await g.members.findByTelegramId(1))?.invitesIssued).toBe(2);
    expect((await g.members.stats()).activeMembers).toBe(1);
  });

  it('a revocation frees both the wallet and the Telegram account', async () => {
    const w1 = wallet(1);
    const w2 = wallet(2);
    const g = makeGate({ holdings: { [w1.address]: [1] } });
    await verifyFlow(g, 1, w1);
    g.holders.set(w1.address, []);
    await g.service.reverifyAll();

    g.holders.set(w1.address, [5]);
    await verifyFlow(g, 2, w1); // w1 now belongs to tg 2
    g.holders.set(w2.address, [6]);
    await verifyFlow(g, 1, w2); // and tg 1 may use another wallet
    expect((await g.members.findByTelegramId(1))?.address).toBe(w2.address);
    expect((await g.members.findByTelegramId(2))?.address).toBe(w1.address);
  });
});

describe('reverifyAll', () => {
  let g: Gate;
  const holder = wallet(100);
  const seller = wallet(200);
  beforeEach(async () => {
    g = makeGate({ holdings: { [holder.address]: [1, 2], [seller.address]: [3] } });
    await verifyFlow(g, 100, holder);
    await verifyFlow(g, 200, seller);
    g.telegram.messages.length = 0;
    g.holders.calls.length = 0;
  });

  it('keeps holders and kicks (ban + unban) non-holders with a DM saying why', async () => {
    g.holders.set(seller.address, []);
    g.holders.set(holder.address, [1, 2, 9]); // bought another
    const r = await g.service.reverifyAll();
    expect(r).toMatchObject({ checked: 2, kept: [100], kicked: [200], errors: [], kickFailures: [] });
    expect(g.telegram.bans).toEqual([{ chatId: CHAT, userId: 200 }]);
    expect(g.telegram.unbans).toEqual([{ chatId: CHAT, userId: 200, onlyIfBanned: true }]);
    expect(g.telegram.messages).toHaveLength(1);
    expect(g.telegram.messages[0]).toMatchObject({ chatId: 200, text: expect.stringContaining(seller.address) });
    expect(await g.members.findByTelegramId(200)).toMatchObject({ status: 'revoked', degents: [], kickPending: false });
    expect(await g.members.findByTelegramId(100)).toMatchObject({ status: 'active', degents: [1, 2, 9] });
    expect(g.holders.calls).toEqual(expect.arrayContaining([{ address: holder.address, fresh: true }]));
  });

  it('never kicks when the Register fails', async () => {
    g.holders.set(seller.address, new Error('timeout'));
    const r = await g.service.reverifyAll();
    expect(r.kicked).toEqual([]);
    expect(r.errors).toEqual([{ telegramUserId: 200, error: 'timeout' }]);
    expect(g.telegram.bans).toEqual([]);
    expect(await g.members.findByTelegramId(200)).toMatchObject({ status: 'active' });
  });

  it('skips already revoked members on later runs', async () => {
    g.holders.set(seller.address, []);
    await g.service.reverifyAll();
    const r = await g.service.reverifyAll();
    expect(r.checked).toBe(1);
    expect(g.telegram.bans).toHaveLength(1);
  });

  it('records the revocation when Telegram refuses the kick, and retries the kick next run', async () => {
    g.holders.set(seller.address, []);
    g.telegram.failNext('banChatMember', 'Bad Request: not enough rights');
    const r = await g.service.reverifyAll();
    expect(r).toMatchObject({ kicked: [200], kickFailures: [200] });
    expect(await g.members.findByTelegramId(200)).toMatchObject({ status: 'revoked', kickPending: true });
    const r2 = await g.service.reverifyAll();
    expect(r2.kickFailures).toEqual([]);
    expect(g.telegram.bans).toEqual([{ chatId: CHAT, userId: 200 }]);
    expect(await g.members.findByTelegramId(200)).toMatchObject({ kickPending: false });
  });

  it('a failed revocation DM does not stop the run', async () => {
    g.holders.set(seller.address, []);
    g.holders.set(holder.address, []);
    g.telegram.failNext('sendMessage');
    const r = await g.service.reverifyAll();
    expect(r.kicked.sort()).toEqual([100, 200]);
    expect(g.telegram.bans).toHaveLength(2);
  });

  it('a re-verified seller who buys back becomes active again', async () => {
    g.holders.set(seller.address, []);
    await g.service.reverifyAll();
    g.holders.set(seller.address, [77]);
    const { result } = await verifyFlow(g, 200, seller);
    expect(result.degents).toEqual([77]);
    expect(await g.members.findByTelegramId(200)).toMatchObject({ status: 'active', kickPending: false });
  });
});

describe('stats and operator sessions', () => {
  const admin = wallet(500);

  async function adminToken(g: Gate): Promise<string> {
    const ch = await g.service.adminChallenge({ address: admin.address });
    return (await g.service.adminVerify({ address: admin.address, message: ch.message, signature: admin.sign(ch.message) })).token;
  }

  it('counts active, revoked, Degents held, invites and the last re-verification', async () => {
    const w1 = wallet(1);
    const w2 = wallet(2);
    const g = makeGate({ holdings: { [w1.address]: [1, 2], [w2.address]: [3] } });
    await verifyFlow(g, 1, w1);
    await verifyFlow(g, 2, w2);
    g.holders.set(w2.address, []);
    await g.service.reverifyAll();
    expect(await g.service.stats()).toEqual({
      activeMembers: 1,
      revokedMembers: 1,
      degentsHeld: 2,
      invitesIssued: 2,
      kickPending: 0,
      lastReverify: { at: new Date(T0).toISOString(), checked: 2, kept: 1, kicked: 1, errors: 0, kickFailures: 0 },
    });
  });

  it('an operator signs in with SIWB and gets a gate:admin session', async () => {
    const g = makeGate({ settings: { adminAddresses: [admin.address] } });
    const token = await adminToken(g);
    const claims = g.service.authorizeAdmin(`Bearer ${token}`);
    expect(claims).toMatchObject({ sub: admin.address, aud: 'degent-telegram-gate', scopes: ['gate:admin'] });
  });

  it('refuses non-operators, missing and expired sessions', async () => {
    const g = makeGate({ settings: { adminAddresses: [admin.address] } });
    await expect(g.service.adminChallenge({ address: wallet(1).address })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(() => g.service.authorizeAdmin(undefined)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => g.service.authorizeAdmin('Bearer not-a-real-session-token')).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    const token = await adminToken(g);
    g.advance(3700 * 1000); // past exp + the 30 s leeway
    expect(() => g.service.authorizeAdmin(`Bearer ${token}`)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('a holder gate signature cannot be used as an operator sign-in', async () => {
    const g = makeGate({ settings: { adminAddresses: [admin.address] }, holdings: { [admin.address]: [1] } });
    const token = await linkFor(g, 9);
    const ch = await g.service.challenge({ token, address: admin.address });
    await expect(g.service.adminVerify({ address: admin.address, message: ch.message, signature: admin.sign(ch.message) })).rejects.toMatchObject({
      code: 'bad_message',
    });
  });

  it('a session stops working when the address leaves the operator list', async () => {
    const g = makeGate({ settings: { adminAddresses: [admin.address] } });
    const token = await adminToken(g);
    const demoted = makeGate({ settings: { adminAddresses: [] } });
    // same session key in both harnesses (key(9999)), different operator list
    expect(() => demoted.service.authorizeAdmin(`Bearer ${token}`)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
});
