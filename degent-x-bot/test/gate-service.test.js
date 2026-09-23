import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGateService, GateError } from '../src/telegram-gate/service';
import { createMemoryRepo } from '../src/telegram-gate/repo-memory';
import { makeWallet, verifyBip322 } from './helpers/wallet';

const CHAT = '-1001234567890';

function fakeTelegram() {
  let n = 0;
  return {
    createChatInviteLink: vi.fn(async (chatId, opts) => ({ invite_link: `https://t.me/+invite${++n}`, ...opts })),
    banChatMember: vi.fn(async () => true),
    unbanChatMember: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({ message_id: n })),
  };
}

function fakeHolders(map) {
  return {
    map,
    getHoldings: vi.fn(async (address) => {
      const v = map[address];
      if (v instanceof Error) throw v;
      return v || [];
    }),
  };
}

function build({ holdings = {}, verifySig = verifyBip322 } = {}) {
  let t = 1_700_000_000_000;
  const now = () => t;
  const repo = createMemoryRepo({ now });
  const telegram = fakeTelegram();
  const holders = fakeHolders(holdings);
  const config = {
    admin: { jwtSecret: 'a'.repeat(40) },
    gate: {
      holdersChatId: CHAT,
      webBaseUrl: 'https://degent.club',
      jwtSecret: 'g'.repeat(40),
      linkTtlMs: 10 * 60 * 1000,
      inviteTtlMs: 10 * 60 * 1000,
      verifyRateLimit: { max: 3, windowMs: 10 * 60 * 1000 },
    },
  };
  const service = createGateService({ repo, holders, telegram, config, verifySig, now });
  return { service, repo, telegram, holders, config, advance: (ms) => (t += ms) };
}

/** Full happy path helper: /verify -> challenge -> sign -> verify. */
async function verifyFlow(ctx, { tg, wallet }) {
  const { url } = await ctx.service.startVerification(tg);
  const token = new URL(url).searchParams.get('tg');
  const ch = await ctx.service.challenge({ token, address: wallet.address });
  const signature = wallet.sign(ch.message);
  return { token, ch, result: await ctx.service.verify({ token, address: wallet.address, message: ch.message, signature }) };
}

describe('startVerification', () => {
  it('returns a one-time link on the web base url with a token for that user', async () => {
    const ctx = build();
    const { url, text } = await ctx.service.startVerification(99);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://degent.club/verify');
    expect(u.searchParams.get('tg')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(text).toContain(url);
  });

  it('rate limits /verify per user', async () => {
    const ctx = build();
    for (let i = 0; i < 3; i++) await ctx.service.startVerification(5);
    await expect(ctx.service.startVerification(5)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(ctx.service.startVerification(6)).resolves.toBeTruthy(); // other user unaffected
    ctx.advance(10 * 60 * 1000 + 1);
    await expect(ctx.service.startVerification(5)).resolves.toBeTruthy();
  });

  it('rejects bad telegram ids', async () => {
    const ctx = build();
    await expect(ctx.service.startVerification(0)).rejects.toBeInstanceOf(GateError);
    await expect(ctx.service.startVerification('x')).rejects.toBeInstanceOf(GateError);
  });
});

describe('challenge', () => {
  it('issues a message bound to the token user, the address and a fresh nonce', async () => {
    const ctx = build();
    const w = makeWallet();
    const { token } = await ctx.service.startVerification(11);
    const ch = await ctx.service.challenge({ token, address: w.address });
    expect(ch.message).toBe(
      `degent.club telegram\ntelegram:11\naddress:${w.address}\nnonce:${ch.nonce}\nexpires:${ch.expires}`,
    );
    expect(ch.nonce).toMatch(/^[a-f0-9]{32}$/);
    const ch2 = await ctx.service.challenge({ token, address: w.address });
    expect(ch2.nonce).not.toBe(ch.nonce);
  });

  it('rejects an expired or forged token', async () => {
    const ctx = build();
    const w = makeWallet();
    const { token } = await ctx.service.startVerification(11);
    ctx.advance(11 * 60 * 1000);
    await expect(ctx.service.challenge({ token, address: w.address })).rejects.toMatchObject({ code: 'bad_token', status: 401 });
    await expect(ctx.service.challenge({ token: 'a.b.c', address: w.address })).rejects.toMatchObject({ code: 'bad_token' });
  });

  it('rejects a non-bitcoin address', async () => {
    const ctx = build();
    const { token } = await ctx.service.startVerification(11);
    await expect(ctx.service.challenge({ token, address: '0xdeadbeef' })).rejects.toMatchObject({ code: 'bad_address' });
  });
});

describe('verify', () => {
  it('happy path: verifies, stores the member, issues exactly one invite, DMs it', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: [101, 202] } });
    const { result } = await verifyFlow(ctx, { tg: 42, wallet: w });

    expect(result.ok).toBe(true);
    expect(result.degents).toEqual([101, 202]);
    expect(result.inviteLink).toBe('https://t.me/+invite1');

    expect(ctx.telegram.createChatInviteLink).toHaveBeenCalledTimes(1);
    expect(ctx.telegram.createChatInviteLink).toHaveBeenCalledWith(CHAT, expect.objectContaining({ member_limit: 1 }));
    const inviteOpts = ctx.telegram.createChatInviteLink.mock.calls[0][1];
    expect(inviteOpts.expire_date * 1000).toBe(1_700_000_000_000 + 10 * 60 * 1000);

    expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.telegram.sendMessage.mock.calls[0][0]).toBe(42);
    expect(ctx.telegram.sendMessage.mock.calls[0][1]).toContain('https://t.me/+invite1');

    const member = await ctx.repo.findMemberByTelegramId(42);
    expect(member).toMatchObject({ address: w.address, degents: [101, 202], status: 'active' });
    expect(member.verifiedAt).toBeInstanceOf(Date);
    expect(member.inviteIssuedAt).toBeInstanceOf(Date);
    expect(ctx.holders.getHoldings).toHaveBeenCalledWith(w.address, { fresh: true });
  });

  it('works with a taproot wallet too', async () => {
    const w = makeWallet('p2tr');
    const ctx = build({ holdings: { [w.address]: [1] } });
    const { result } = await verifyFlow(ctx, { tg: 43, wallet: w });
    expect(result.ok).toBe(true);
  });

  it('a nonce is single use', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: [1] } });
    const { token, ch } = await verifyFlow(ctx, { tg: 42, wallet: w });
    const signature = w.sign(ch.message);
    await expect(ctx.service.verify({ token, address: w.address, message: ch.message, signature }))
      .rejects.toMatchObject({ code: 'bad_nonce', status: 401 });
    expect(ctx.telegram.createChatInviteLink).toHaveBeenCalledTimes(1); // still exactly one
  });

  it('a nonce expires', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: [1] } });
    const { token } = await ctx.service.startVerification(42);
    const ch = await ctx.service.challenge({ token, address: w.address });
    const signature = w.sign(ch.message);
    ctx.advance(9 * 60 * 1000);
    // token and nonce were issued at the same moment; both expire at +10 min
    ctx.advance(2 * 60 * 1000);
    await expect(ctx.service.verify({ token, address: w.address, message: ch.message, signature }))
      .rejects.toMatchObject({ status: 401 });
    expect(ctx.telegram.createChatInviteLink).not.toHaveBeenCalled();
  });

  it('rejects a bad signature', async () => {
    const w = makeWallet();
    const other = makeWallet();
    const ctx = build({ holdings: { [w.address]: [1] } });
    const { token } = await ctx.service.startVerification(42);
    const ch = await ctx.service.challenge({ token, address: w.address });
    const signature = other.sign(ch.message); // signed by the wrong key
    await expect(ctx.service.verify({ token, address: w.address, message: ch.message, signature }))
      .rejects.toMatchObject({ code: 'bad_signature', status: 401 });
    expect(ctx.telegram.createChatInviteLink).not.toHaveBeenCalled();
  });

  it('rejects an altered message even with a valid signature over it', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: [1] } });
    const { token } = await ctx.service.startVerification(42);
    const ch = await ctx.service.challenge({ token, address: w.address });
    const altered = ch.message.replace('expires:', 'expires:2099-01-01T00:00:00.000Z\nx:'); // wrong shape
    await expect(ctx.service.verify({ token, address: w.address, message: altered, signature: w.sign(altered) }))
      .rejects.toMatchObject({ code: 'bad_message' });
    const forTg = ch.message.replace('telegram:42', 'telegram:43');
    await expect(ctx.service.verify({ token, address: w.address, message: forTg, signature: w.sign(forTg) }))
      .rejects.toMatchObject({ code: 'bad_message' });
  });

  it('rejects a non-holder without issuing an invite or storing a member', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: {} });
    await expect(verifyFlow(ctx, { tg: 42, wallet: w })).rejects.toMatchObject({ code: 'not_a_holder', status: 403 });
    expect(ctx.telegram.createChatInviteLink).not.toHaveBeenCalled();
    expect(await ctx.repo.findMemberByTelegramId(42)).toBeNull();
  });

  it('propagates holder API failures (no invite on error)', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: new Error('api down') } });
    await expect(verifyFlow(ctx, { tg: 42, wallet: w })).rejects.toThrow('api down');
    expect(ctx.telegram.createChatInviteLink).not.toHaveBeenCalled();
  });
});

describe('one wallet <-> one telegram account', () => {
  it('rejects a wallet already linked to another telegram account, at challenge and at verify', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: [1] } });
    await verifyFlow(ctx, { tg: 1, wallet: w });

    const { token } = await ctx.service.startVerification(2);
    await expect(ctx.service.challenge({ token, address: w.address }))
      .rejects.toMatchObject({ code: 'address_taken', status: 409 });
    expect(ctx.telegram.createChatInviteLink).toHaveBeenCalledTimes(1);
  });

  it('rejects a telegram account already linked to another wallet', async () => {
    const w1 = makeWallet();
    const w2 = makeWallet();
    const ctx = build({ holdings: { [w1.address]: [1], [w2.address]: [2] } });
    await verifyFlow(ctx, { tg: 1, wallet: w1 });

    const { token } = await ctx.service.startVerification(1);
    let err;
    try {
      await ctx.service.challenge({ token, address: w2.address });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'telegram_taken', status: 409 });
    expect(err.message).toContain(w1.address);
  });

  it('lets the same pair re-verify (e.g. lost invite) and issues a new invite', async () => {
    const w = makeWallet();
    const ctx = build({ holdings: { [w.address]: [1] } });
    await verifyFlow(ctx, { tg: 1, wallet: w });
    const second = await verifyFlow(ctx, { tg: 1, wallet: w });
    expect(second.result.inviteLink).toBe('https://t.me/+invite2');
    expect(ctx.telegram.createChatInviteLink).toHaveBeenCalledTimes(2);
    expect(ctx.repo._members.size).toBe(1);
  });

  it('a revoked link frees both the wallet and the telegram account', async () => {
    const w1 = makeWallet();
    const w2 = makeWallet();
    const ctx = build({ holdings: { [w1.address]: [1] } });
    await verifyFlow(ctx, { tg: 1, wallet: w1 });
    ctx.holders.map[w1.address] = [];
    await ctx.service.reverifyAll();

    // w1 now belongs to nobody -> tg 2 may claim it once it holds again
    ctx.holders.map[w1.address] = [5];
    await verifyFlow(ctx, { tg: 2, wallet: w1 });
    // and tg 1 may verify with a different wallet
    ctx.holders.map[w2.address] = [6];
    await verifyFlow(ctx, { tg: 1, wallet: w2 });
    expect((await ctx.repo.findMemberByTelegramId(1)).address).toBe(w2.address);
    expect((await ctx.repo.findMemberByTelegramId(2)).address).toBe(w1.address);
  });
});

describe('reverifyAll', () => {
  let ctx;
  let holder;
  let seller;
  beforeEach(async () => {
    holder = makeWallet();
    seller = makeWallet();
    ctx = build({ holdings: { [holder.address]: [1, 2], [seller.address]: [3] } });
    await verifyFlow(ctx, { tg: 100, wallet: holder });
    await verifyFlow(ctx, { tg: 200, wallet: seller });
    vi.clearAllMocks();
  });

  it('keeps holders and kicks (ban + unban) non-holders with a DM', async () => {
    ctx.holders.map[seller.address] = [];
    ctx.holders.map[holder.address] = [1, 2, 9]; // bought another

    const r = await ctx.service.reverifyAll();
    expect(r).toMatchObject({ checked: 2, kept: [100], kicked: [200], errors: [] });

    expect(ctx.telegram.banChatMember).toHaveBeenCalledTimes(1);
    expect(ctx.telegram.banChatMember).toHaveBeenCalledWith(CHAT, 200);
    expect(ctx.telegram.unbanChatMember).toHaveBeenCalledWith(CHAT, 200, { only_if_banned: true });
    expect(ctx.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx.telegram.sendMessage.mock.calls[0][0]).toBe(200);
    expect(ctx.telegram.sendMessage.mock.calls[0][1]).toContain(seller.address);

    expect(await ctx.repo.findMemberByTelegramId(200)).toMatchObject({ status: 'revoked', degents: [] });
    expect(await ctx.repo.findMemberByTelegramId(100)).toMatchObject({ status: 'active', degents: [1, 2, 9] });
    expect(ctx.holders.getHoldings).toHaveBeenCalledWith(holder.address, { fresh: true });
  });

  it('does not kick when the holder API fails', async () => {
    ctx.holders.map[seller.address] = new Error('timeout');
    const r = await ctx.service.reverifyAll();
    expect(r.kicked).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(ctx.telegram.banChatMember).not.toHaveBeenCalled();
    expect(await ctx.repo.findMemberByTelegramId(200)).toMatchObject({ status: 'active' });
  });

  it('skips already revoked members on later runs', async () => {
    ctx.holders.map[seller.address] = [];
    await ctx.service.reverifyAll();
    vi.clearAllMocks();
    const r = await ctx.service.reverifyAll();
    expect(r.checked).toBe(1);
    expect(ctx.telegram.banChatMember).not.toHaveBeenCalled();
  });

  it('still records the kick if the Telegram API throws', async () => {
    ctx.holders.map[seller.address] = [];
    ctx.telegram.banChatMember.mockRejectedValueOnce(new Error('bot is not admin'));
    const r = await ctx.service.reverifyAll();
    expect(r.kicked).toEqual([200]);
    expect(await ctx.repo.findMemberByTelegramId(200)).toMatchObject({ status: 'revoked' });
  });
});

describe('stats', () => {
  it('counts active, revoked, degents and open challenges', async () => {
    const w1 = makeWallet();
    const w2 = makeWallet();
    const ctx = build({ holdings: { [w1.address]: [1, 2], [w2.address]: [3] } });
    await verifyFlow(ctx, { tg: 1, wallet: w1 });
    await verifyFlow(ctx, { tg: 2, wallet: w2 });
    ctx.holders.map[w2.address] = [];
    await ctx.service.reverifyAll();
    const { token } = await ctx.service.startVerification(3);
    await ctx.service.challenge({ token, address: makeWallet().address });

    expect(await ctx.service.stats()).toEqual({ activeMembers: 1, revokedMembers: 1, degentsHeld: 2, openChallenges: 1 });
  });
});
