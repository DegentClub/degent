// Core gate logic, independent of grammY / Fastify / BullMQ so it can be
// tested with fakes. Everything external is injected:
//
//   repo      repo-memory.js / repo-postgres.js
//   holders   holders.js client ({ getHoldings })
//   telegram  { createChatInviteLink, banChatMember, unbanChatMember, sendMessage }
//   verifySig (address, message, signature) => boolean
//   now       () => epoch ms

const crypto = require('node:crypto');
const { signLinkToken, verifyLinkToken } = require('./tokens');
const { buildMessage, parseMessage, looksLikeBitcoinAddress } = require('./message');

class GateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = {
  linkIntro: (url) =>
    `Holders only, gentlemen. Sign a message with the wallet that holds your Degent to prove it.\n\n` +
    `Open this link within 10 minutes — it works once:\n${url}\n\n` +
    `Nothing is sent from your wallet. You only sign text.`,
  welcome: (invite, count) =>
    `Verified. ${count} Degent${count === 1 ? '' : 's'} on record.\n\n` +
    `Your invite (single use, expires in 10 minutes):\n${invite}\n\nWelcome to the club.`,
  revoked: (address) =>
    `Your membership of the holders group was revoked: the wallet you verified (${address}) no longer holds a Degent.\n\n` +
    `If that changes, send /verify again and you can rejoin.`,
  rateLimited: 'Easy, ser. Try /verify again in a few minutes.',
};

function createGateService(deps) {
  const {
    repo,
    holders,
    telegram,
    config,
    verifySig,
    logger,
    now = Date.now,
  } = deps;
  const g = config.gate;

  // --- /verify rate limit (per Telegram user, in memory) -----------------
  const verifyHits = new Map();
  function checkVerifyRate(telegramUserId) {
    const { max, windowMs } = g.verifyRateLimit;
    const t = now();
    const recent = (verifyHits.get(telegramUserId) || []).filter((x) => x > t - windowMs);
    if (recent.length >= max) {
      verifyHits.set(telegramUserId, recent);
      return false;
    }
    recent.push(t);
    verifyHits.set(telegramUserId, recent);
    return true;
  }

  function assertTelegramId(id) {
    if (!Number.isInteger(id) || id <= 0) throw new GateError('bad_telegram_id', 'invalid telegram user id');
  }

  function readToken(token) {
    const r = verifyLinkToken(token, { secret: g.jwtSecret, now });
    if (!r.ok) throw new GateError('bad_token', `link ${r.reason}`, 401);
    return r.claims.tg;
  }

  async function assertNotTaken({ telegramUserId, address }) {
    const byAddress = await repo.findMemberByAddress(address);
    if (byAddress && byAddress.status === 'active' && byAddress.telegramUserId !== telegramUserId) {
      throw new GateError('address_taken', 'this wallet is already linked to another Telegram account', 409);
    }
    const byTg = await repo.findMemberByTelegramId(telegramUserId);
    if (byTg && byTg.status === 'active' && byTg.address.toLowerCase() !== address.toLowerCase()) {
      throw new GateError('telegram_taken', `this Telegram account is already linked to wallet ${byTg.address}`, 409);
    }
  }

  // --- 1. /verify in DM --------------------------------------------------
  async function startVerification(telegramUserId) {
    assertTelegramId(telegramUserId);
    if (!checkVerifyRate(telegramUserId)) {
      throw new GateError('rate_limited', MESSAGES.rateLimited, 429);
    }
    const token = signLinkToken({ tg: telegramUserId }, { secret: g.jwtSecret, ttlMs: g.linkTtlMs, now });
    const url = `${g.webBaseUrl}/verify?tg=${encodeURIComponent(token)}`;
    return { url, token, text: MESSAGES.linkIntro(url) };
  }

  // --- 2. POST /gate/challenge ------------------------------------------
  async function challenge({ token, address }) {
    const telegramUserId = readToken(token);
    if (!looksLikeBitcoinAddress(address)) throw new GateError('bad_address', 'address is not a bitcoin address');
    await assertNotTaken({ telegramUserId, address });

    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(now() + g.linkTtlMs);
    await repo.createChallenge({ telegramUserId, address, nonce, expiresAt });
    const message = buildMessage({ telegramUserId, address, nonce, expires: expiresAt });
    return { message, nonce, expires: expiresAt.toISOString() };
  }

  // --- 3-5. POST /gate/verify --------------------------------------------
  async function verify({ token, address, message, signature }) {
    const telegramUserId = readToken(token);
    if (!looksLikeBitcoinAddress(address)) throw new GateError('bad_address', 'address is not a bitcoin address');
    if (typeof signature !== 'string' || signature.length < 20) throw new GateError('bad_signature', 'signature missing');

    const parsed = parseMessage(message);
    if (!parsed) throw new GateError('bad_message', 'message has the wrong shape');
    if (parsed.telegramUserId !== telegramUserId) throw new GateError('bad_message', 'message is for a different telegram account');
    if (parsed.address !== address) throw new GateError('bad_message', 'message is for a different address');

    // Nonce: single use, must belong to this tg id + address, unexpired.
    const ch = await repo.consumeChallenge(parsed.nonce);
    if (!ch) throw new GateError('bad_nonce', 'challenge is unknown, already used, or expired', 401);
    if (ch.telegramUserId !== telegramUserId || ch.address !== address) {
      throw new GateError('bad_nonce', 'challenge does not match this request', 401);
    }
    // The message must be byte-for-byte what we issued.
    const expected = buildMessage({ telegramUserId, address, nonce: ch.nonce, expires: ch.expiresAt });
    if (expected !== message) throw new GateError('bad_message', 'message was altered', 401);

    if (!verifySig(address, message, signature)) {
      throw new GateError('bad_signature', 'signature does not verify for this address', 401);
    }

    await assertNotTaken({ telegramUserId, address });

    const degents = await holders.getHoldings(address, { fresh: true });
    if (degents.length === 0) {
      throw new GateError('not_a_holder', 'this address does not hold a Degent', 403);
    }

    const member = await repo.upsertMember({ telegramUserId, address, degents });

    // Exactly one invite per verification.
    const invite = await telegram.createChatInviteLink(g.holdersChatId, {
      member_limit: 1,
      expire_date: Math.floor((now() + g.inviteTtlMs) / 1000),
      name: `gate:${telegramUserId}`,
    });
    await repo.markInviteIssued(telegramUserId);
    await telegram.sendMessage(telegramUserId, MESSAGES.welcome(invite.invite_link, degents.length));

    logger?.info({ telegramUserId, address, degents: degents.length }, 'gate: member verified');
    return { ok: true, inviteLink: invite.invite_link, degents, memberId: member.id };
  }

  // --- 6. re-verification worker -----------------------------------------
  async function reverifyAll() {
    const members = await repo.listActiveMembers();
    const result = { checked: 0, kept: [], kicked: [], errors: [] };

    for (const m of members) {
      result.checked++;
      let degents;
      try {
        degents = await holders.getHoldings(m.address, { fresh: true });
      } catch (err) {
        // Never kick on an API failure — try again next run.
        result.errors.push({ telegramUserId: m.telegramUserId, error: err.message });
        logger?.warn({ err, telegramUserId: m.telegramUserId }, 'gate: holder check failed, keeping member');
        continue;
      }

      if (degents.length > 0) {
        await repo.updateHoldings(m.telegramUserId, degents);
        result.kept.push(m.telegramUserId);
        continue;
      }

      await repo.revokeMember(m.telegramUserId);
      try {
        await telegram.banChatMember(g.holdersChatId, m.telegramUserId);
        await telegram.unbanChatMember(g.holdersChatId, m.telegramUserId, { only_if_banned: true });
      } catch (err) {
        logger?.error({ err, telegramUserId: m.telegramUserId }, 'gate: kick failed');
      }
      try {
        await telegram.sendMessage(m.telegramUserId, MESSAGES.revoked(m.address));
      } catch (err) {
        logger?.warn({ err, telegramUserId: m.telegramUserId }, 'gate: could not DM revoked member');
      }
      result.kicked.push(m.telegramUserId);
      logger?.info({ telegramUserId: m.telegramUserId, address: m.address }, 'gate: member revoked');
    }
    return result;
  }

  // --- 7. admin ----------------------------------------------------------
  async function stats() {
    return repo.stats();
  }

  return { startVerification, challenge, verify, reverifyAll, stats, MESSAGES };
}

module.exports = { createGateService, GateError, MESSAGES };
