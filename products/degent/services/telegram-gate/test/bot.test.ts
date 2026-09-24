/** The DM bot's command handlers (grammY-free) and the grammY TelegramApi adapter's parameter mapping. */
import { describe, expect, it } from 'vitest';
import type { Api } from 'grammy';
import { GrammyTelegramApi, onStart, onVerify } from '../src/adapters/grammy-telegram.js';
import { silentLogger } from '../src/application/logger.js';
import { MESSAGES } from '../src/domain/messages.js';
import { makeGate } from './helpers.js';

describe('bot commands', () => {
  it('/start answers only in private chats', () => {
    expect(onStart({ chatType: 'private', fromId: 1 })).toBe(MESSAGES.start);
    expect(onStart({ chatType: 'supergroup', fromId: 1 })).toBeNull();
  });

  it('/verify in a DM replies with the one-time link', async () => {
    const g = makeGate();
    const text = await onVerify({ chatType: 'private', fromId: 42 }, g.service, silentLogger);
    expect(text).toContain('https://degent.club/verify?tg=');
    expect(text).toContain('it works once');
  });

  it('/verify in a group points to the DM and issues nothing', async () => {
    const g = makeGate();
    expect(await onVerify({ chatType: 'supergroup', fromId: 42 }, g.service, silentLogger)).toBe(MESSAGES.dmOnly);
  });

  it('/verify tells a user who hit the rate limit to wait', async () => {
    const g = makeGate();
    for (let i = 0; i < 3; i++) await onVerify({ chatType: 'private', fromId: 42 }, g.service, silentLogger);
    expect(await onVerify({ chatType: 'private', fromId: 42 }, g.service, silentLogger)).toBe(MESSAGES.rateLimited);
  });

  it('an unexpected failure is a generic reply, never a stack trace', async () => {
    const svc = { startVerification: async () => { throw new Error('boom: secret detail'); } };
    expect(await onVerify({ chatType: 'private', fromId: 1 }, svc, silentLogger)).toBe(MESSAGES.failed);
  });
});

describe('GrammyTelegramApi', () => {
  it('maps the port onto Bot API parameters', async () => {
    const calls: unknown[][] = [];
    const api = {
      createChatInviteLink: async (...a: unknown[]) => (calls.push(['createChatInviteLink', ...a]), { invite_link: 'https://t.me/+x' }),
      banChatMember: async (...a: unknown[]) => (calls.push(['banChatMember', ...a]), true),
      unbanChatMember: async (...a: unknown[]) => (calls.push(['unbanChatMember', ...a]), true),
      sendMessage: async (...a: unknown[]) => (calls.push(['sendMessage', ...a]), {}),
    } as unknown as Api;
    const t = new GrammyTelegramApi(api);
    expect(await t.createInviteLink('-100', { memberLimit: 1, expireDate: 1700000600, name: 'gate:1' })).toEqual({ inviteLink: 'https://t.me/+x' });
    await t.banChatMember('-100', 7);
    await t.unbanChatMember('-100', 7, { onlyIfBanned: true });
    await t.sendMessage(7, 'hi');
    expect(calls).toEqual([
      ['createChatInviteLink', '-100', { member_limit: 1, expire_date: 1700000600, name: 'gate:1' }],
      ['banChatMember', '-100', 7],
      ['unbanChatMember', '-100', 7, { only_if_banned: true }],
      ['sendMessage', 7, 'hi', { link_preview_options: { is_disabled: true } }],
    ]);
  });
});
