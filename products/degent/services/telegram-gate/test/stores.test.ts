/** MemberStore contract, run against both adapters; the sqlite NonceStore against the @bsh/identity port semantics. */
import { describe, expect, it } from 'vitest';
import { MemoryMemberStore } from '../src/adapters/memory-member-store.js';
import { openGateDatabase, SqliteMemberStore, SqliteNonceStore } from '../src/adapters/sqlite-stores.js';
import type { MemberStore } from '../src/ports/member-store.js';
import { makeGate, verifyFlow, wallet } from './helpers.js';

const AT = '2026-09-24T12:00:00.000Z';
const LATER = '2026-09-24T18:00:00.000Z';

const adapters: Array<[string, () => MemberStore]> = [
  ['memory', () => new MemoryMemberStore()],
  ['sqlite', () => new SqliteMemberStore(openGateDatabase(':memory:'))],
];

describe.each(adapters)('MemberStore (%s)', (_name, make) => {
  it('upserts, finds by Telegram id and by active address (bech32 case-insensitive)', async () => {
    const s = make();
    const m = await s.upsertVerified({ telegramUserId: 1, address: 'bc1qabc', degents: [3, 4], at: AT });
    expect(m).toMatchObject({ telegramUserId: 1, address: 'bc1qabc', degents: [3, 4], status: 'active', verifiedAt: AT, invitesIssued: 0, kickPending: false });
    expect(await s.findByTelegramId(1)).toEqual(m);
    expect((await s.findActiveByAddress('BC1QABC'))?.telegramUserId).toBe(1);
    expect(await s.findByTelegramId(2)).toBeNull();
    expect(await s.findActiveByAddress('bc1qother')).toBeNull();
  });

  it('records invites cumulatively', async () => {
    const s = make();
    await s.upsertVerified({ telegramUserId: 1, address: 'a', degents: [1], at: AT });
    await s.recordInvite(1, AT);
    await s.upsertVerified({ telegramUserId: 1, address: 'a', degents: [1], at: LATER });
    await s.recordInvite(1, LATER);
    expect(await s.findByTelegramId(1)).toMatchObject({ invitesIssued: 2, inviteIssuedAt: LATER, verifiedAt: LATER });
  });

  it('revoke clears holdings, frees the address and marks the kick pending until markKicked', async () => {
    const s = make();
    await s.upsertVerified({ telegramUserId: 1, address: 'bc1qabc', degents: [1], at: AT });
    await s.revoke(1, LATER);
    expect(await s.findByTelegramId(1)).toMatchObject({ status: 'revoked', degents: [], revokedAt: LATER, kickPending: true });
    expect(await s.findActiveByAddress('bc1qabc')).toBeNull();
    expect((await s.listKickPending()).map((m) => m.telegramUserId)).toEqual([1]);
    await s.markKicked(1);
    expect(await s.listKickPending()).toEqual([]);
  });

  it('re-activation after a revoke resets the revocation', async () => {
    const s = make();
    await s.upsertVerified({ telegramUserId: 1, address: 'a', degents: [1], at: AT });
    await s.revoke(1, AT);
    await s.upsertVerified({ telegramUserId: 1, address: 'b', degents: [2], at: LATER });
    expect(await s.findByTelegramId(1)).toMatchObject({ status: 'active', address: 'b', revokedAt: null, kickPending: false });
  });

  it('lists active members and updates holdings', async () => {
    const s = make();
    await s.upsertVerified({ telegramUserId: 2, address: 'b', degents: [2], at: AT });
    await s.upsertVerified({ telegramUserId: 1, address: 'a', degents: [1], at: AT });
    await s.revoke(2, AT);
    await s.updateHoldings(1, [1, 9], LATER);
    const active = await s.listActive();
    expect(active.map((m) => [m.telegramUserId, m.degents, m.lastCheckedAt])).toEqual([[1, [1, 9], LATER]]);
  });

  it('consumes a link id once, and forgets it after it expires', async () => {
    const s = make();
    expect(await s.consumeLink('j1', 1000, 0)).toBe(true);
    expect(await s.consumeLink('j1', 1000, 500)).toBe(false);
    expect(await s.consumeLink('j2', 1000, 500)).toBe(true);
    expect(await s.consumeLink('j1', 5000, 2000)).toBe(true); // the old row expired and was purged
  });

  it('stats', async () => {
    const s = make();
    await s.upsertVerified({ telegramUserId: 1, address: 'a', degents: [1, 2], at: AT });
    await s.upsertVerified({ telegramUserId: 2, address: 'b', degents: [3], at: AT });
    await s.recordInvite(1, AT);
    await s.recordInvite(2, AT);
    await s.revoke(2, AT);
    expect(await s.stats()).toEqual({ activeMembers: 1, revokedMembers: 1, degentsHeld: 2, invitesIssued: 2, kickPending: 1 });
  });

  it('drives the whole gate flow', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [5] }, members: make() });
    await verifyFlow(g, 10, w);
    g.holders.set(w.address, []);
    await g.service.reverifyAll();
    expect(await g.members.findByTelegramId(10)).toMatchObject({ status: 'revoked', kickPending: false });
  });
});

describe('SqliteMemberStore', () => {
  it('the partial unique index refuses a second ACTIVE member on one address', async () => {
    const s = new SqliteMemberStore(openGateDatabase(':memory:'));
    await s.upsertVerified({ telegramUserId: 1, address: 'bc1qabc', degents: [1], at: AT });
    await expect(s.upsertVerified({ telegramUserId: 2, address: 'BC1QABC', degents: [1], at: AT })).rejects.toThrow(/UNIQUE/);
    await s.revoke(1, AT);
    await expect(s.upsertVerified({ telegramUserId: 2, address: 'bc1qabc', degents: [1], at: AT })).resolves.toMatchObject({ telegramUserId: 2 });
  });

  it('persists across reopen of the same file', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    try {
      const db1 = openGateDatabase(join(dir, 'gate.db'));
      await new SqliteMemberStore(db1).upsertVerified({ telegramUserId: 1, address: 'a', degents: [1], at: AT });
      db1.close();
      const db2 = openGateDatabase(join(dir, 'gate.db'));
      expect(await new SqliteMemberStore(db2).findByTelegramId(1)).toMatchObject({ address: 'a' });
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteNonceStore', () => {
  const rec = (nonce: string, expiresAt = Date.now() + 60_000) => ({ nonce, expiresAt, domain: 'degent.club', address: 'bc1qabc' });
  const bind = { domain: 'degent.club', address: 'bc1qabc' };

  it('consumes once: ok, then replayed', async () => {
    const s = new SqliteNonceStore(openGateDatabase(':memory:'));
    await s.issue(rec('n1'));
    expect(await s.consume('n1', bind, Date.now())).toBe('ok');
    expect(await s.consume('n1', bind, Date.now())).toBe('replayed');
  });

  it('unknown nonce, wrong binding, expired', async () => {
    const s = new SqliteNonceStore(openGateDatabase(':memory:'));
    await s.issue(rec('n1'));
    expect(await s.consume('nope', bind, Date.now())).toBe('unknown');
    expect(await s.consume('n1', { ...bind, address: 'bc1qother' }, Date.now())).toBe('unknown');
    expect(await s.consume('n1', bind, Date.now() + 120_000)).toBe('expired');
  });

  it('refuses a duplicate issue', async () => {
    const s = new SqliteNonceStore(openGateDatabase(':memory:'));
    await s.issue(rec('n1'));
    await expect(s.issue(rec('n1'))).rejects.toThrow('nonce already issued');
  });

  it('works as the gate nonce store end to end (a challenge is single use)', async () => {
    const w = wallet(1);
    const g = makeGate({ holdings: { [w.address]: [5] }, nonces: new SqliteNonceStore(openGateDatabase(':memory:')) });
    const { ch, signature } = await verifyFlow(g, 10, w);
    const { url } = await g.service.startVerification(10);
    const token = new URL(url).searchParams.get('tg')!;
    await expect(g.service.verify({ token, address: w.address, message: ch.message, signature })).rejects.toMatchObject({ code: 'auth_failed' });
  });
});
