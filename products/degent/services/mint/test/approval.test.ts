/**
 * Member approval (ADR-0005): the pure rules in domain/approval.ts and the HTTP surface
 * (SIWB sign-in via @bsh/identity, review queue, BIP-322-signed votes, quorums, numbering).
 */
import { describe, expect, it } from 'vitest';
import { signBip322Simple } from '@bsh/identity';
import type { Order, VotesResponse } from '@bsh/degent-mint-sdk';
import { voteStatement } from '@bsh/degent-mint-sdk';
import { approvalInfo, checkVote, nextDegentNumber, tally, verdict, votingDegent, type VoteRecord } from '../src/domain/approval.js';
import {
  api,
  browserMintToPayment,
  castVote,
  fundAndApprove,
  fundToReview,
  makeHarness,
  MEMBER_SEEDS,
  membersApprove,
  regtestAddress,
  regtestKey,
  signIn,
  signVote,
  type Harness,
} from './fakes/harness.js';

const cfg = { approvalQuorum: 3, declineQuorum: 3, reviewSlaSeconds: 14 * 86_400, gallerySize: 4112 };
const vote = (voterAddress: string, v: 'approve' | 'decline', degent = 1): VoteRecord => ({
  orderId: 'dgt_1',
  voterAddress,
  voterDegent: degent,
  vote: v,
  at: '2026-09-23T12:00:00.000Z',
  signature: 'AA==',
  message: 'm',
});
const order = { id: 'dgt_1', status: 'member_review' as const, recipientAddress: 'bcrt1p_recipient', inscriptionId: null, contentSha256: 'a'.repeat(64) };

describe('approval rules (pure)', () => {
  it('tallies and decides by quorum; approval is checked first', () => {
    expect(tally([vote('a', 'approve'), vote('b', 'decline'), vote('c', 'approve')])).toEqual({ approvals: 2, declines: 1 });
    expect(verdict({ approvals: 2, declines: 2 }, cfg)).toBe('open');
    expect(verdict({ approvals: 3, declines: 0 }, cfg)).toBe('approved');
    expect(verdict({ approvals: 0, declines: 3 }, cfg)).toBe('declined');
    expect(verdict({ approvals: 3, declines: 3 }, cfg)).toBe('approved');
    expect(verdict({ approvals: 1, declines: 0 }, { approvalQuorum: 1, declineQuorum: 1 })).toBe('approved');
  });

  it('numbers approved orders after the Gallery, monotonically', () => {
    expect(nextDegentNumber(0, cfg)).toBe(4113);
    expect(nextDegentNumber(41, cfg)).toBe(4154);
    expect(votingDegent([77, 3, 500])).toBe(3);
  });

  it('exposes the SLA deadline with the tally', () => {
    const info = approvalInfo({ reviewStartedAt: '2026-09-23T12:00:00.000Z' }, [vote('a', 'approve')], cfg);
    expect(info).toEqual({ approvals: 1, declines: 0, approvalQuorum: 3, declineQuorum: 3, reviewStartedAt: '2026-09-23T12:00:00.000Z', reviewDeadline: '2026-10-07T12:00:00.000Z' });
    expect(approvalInfo({ reviewStartedAt: null }, [], cfg)).toMatchObject({ reviewStartedAt: null, reviewDeadline: null });
  });

  it.each([
    ['closed review', { order: { ...order, status: 'queued' as const } }, 'review_closed'],
    ['non-holder', { voterDegents: [] }, 'not_a_holder'],
    ['self vote', { voterAddress: order.recipientAddress }, 'self_vote'],
    ['second vote', { existing: [vote('bcrt1p_voter', 'decline')] }, 'already_voted'],
    ['wrong vote word', { message: voteStatement('decline', 'dgt_1', 'a'.repeat(64)) }, 'vote_invalid'],
    ['other order', { message: voteStatement('approve', 'dgt_2', 'a'.repeat(64)) }, 'vote_invalid'],
    ['other content', { message: voteStatement('approve', 'dgt_1', 'b'.repeat(64)) }, 'vote_invalid'],
    ['garbage', { message: 'I approve' }, 'vote_invalid'],
  ])('rejects %s', (_n, over, code) => {
    const r = checkVote({ order, voterAddress: 'bcrt1p_voter', voterDegents: [9], vote: 'approve', message: voteStatement('approve', 'dgt_1', 'a'.repeat(64)), existing: [], ...over });
    expect(r?.code).toBe(code);
  });

  it('accepts a well-formed first vote by a holder on someone else\'s order', () => {
    expect(checkVote({ order, voterAddress: 'bcrt1p_voter', voterDegents: [9], vote: 'approve', message: voteStatement('approve', 'dgt_1', 'a'.repeat(64)), existing: [] })).toBeNull();
    const withId = { ...order, inscriptionId: `${'c'.repeat(64)}i0` };
    expect(checkVote({ order: withId, voterAddress: 'x', voterDegents: [1], vote: 'decline', message: voteStatement('decline', 'dgt_1', `${'c'.repeat(64)}i0`), existing: [] })).toBeNull();
  });
});

describe('holder sign-in (SIWB via @bsh/identity)', () => {
  it('challenge -> BIP-322 signature -> session listing the Degents held', async () => {
    const h = makeHarness();
    const s = await signIn(h, 101);
    expect(s).toMatchObject({ address: regtestAddress(101), degents: [1] });
    expect(s.token.split('.')).toHaveLength(3);
    expect(Date.parse(s.expiresAt)).toBe(h.clock.now().getTime() + 3600 * 1000);
    const multi = await signIn(h, 200);
    expect(multi.degents).toEqual([100, 101]);
  });

  it('refuses non-holders, bad signatures, replayed challenges and foreign addresses', async () => {
    const h = makeHarness();
    const address = regtestAddress(50); // not a member
    const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address } });
    expect(ch.status).toBe(200);
    expect(ch.body.message).toContain(`degent.club wants you to sign in`);
    const sig = signBip322Simple(regtestKey(50), 'p2tr', ch.body.message);
    const notHolder = await api(h, 'POST', '/v1/auth/verify', { json: { address, message: ch.body.message, signature: sig } });
    expect(notHolder.status).toBe(403);
    expect(notHolder.body.error.code).toBe('not_a_holder');
    // nonce was consumed by the (valid) signature above: a replay fails
    const replay = await api(h, 'POST', '/v1/auth/verify', { json: { address, message: ch.body.message, signature: sig } });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('auth_failed');
    // a holder's challenge signed with another key
    const member = regtestAddress(101);
    const ch2 = await api(h, 'POST', '/v1/auth/challenge', { json: { address: member } });
    const wrong = await api(h, 'POST', '/v1/auth/verify', { json: { address: member, message: ch2.body.message, signature: signBip322Simple(regtestKey(102), 'p2tr', ch2.body.message) } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toContain('invalid_signature');
    // an expired challenge
    const ch3 = await api(h, 'POST', '/v1/auth/challenge', { json: { address: member } });
    h.clock.advance(301);
    const late = await api(h, 'POST', '/v1/auth/verify', { json: { address: member, message: ch3.body.message, signature: signBip322Simple(regtestKey(101), 'p2tr', ch3.body.message) } });
    expect(late.status).toBe(401);
    expect(late.body.error.message).toContain('expired');
    // validation
    expect((await api(h, 'POST', '/v1/auth/challenge', { json: { address: 'bc1qmainnet' } })).status).toBe(422);
    expect((await api(h, 'POST', '/v1/auth/verify', { json: { address: member } })).status).toBe(422);
  });

  it('sessions expire and are bound to this service; GET /v1/review needs one', async () => {
    const h = makeHarness();
    expect((await api(h, 'GET', '/v1/review')).status).toBe(401);
    expect((await api(h, 'GET', '/v1/review', { headers: { authorization: 'Bearer abc.def.ghi' } })).status).toBe(401);
    const s = await signIn(h, 101);
    expect((await api(h, 'GET', '/v1/review', { token: s.token })).status).toBe(200);
    h.clock.advance(3600 + 31);
    const expired = await api(h, 'GET', '/v1/review', { token: s.token });
    expect(expired.status).toBe(401);
    expect(expired.body.error.message).toContain('expired');
  });

  it('a member who sold their last Degent loses the session at once', async () => {
    const h = makeHarness();
    const s = await signIn(h, 101);
    h.holders.transfer(1, regtestAddress(60));
    const r = await api(h, 'GET', '/v1/review', { token: s.token });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_a_holder');
  });
});

async function inReview(h: Harness, seed = 42) {
  const b = await browserMintToPayment(h, { recipientSeed: seed });
  await fundToReview(h, b);
  return b;
}

describe('review queue and votes', () => {
  it('lists orders in member_review with tallies and the member\'s own vote', async () => {
    const h = makeHarness();
    const a = await inReview(h, 42);
    const b = await inReview(h, 43);
    await browserMintToPayment(h, { recipientSeed: 44 }); // unpaid: not in the queue
    const s = await signIn(h, 101);
    let q = await api(h, 'GET', '/v1/review', { token: s.token });
    expect(q.body.memberDegents).toEqual([1]);
    expect(q.body.items.map((i: { order: Order }) => i.order.id)).toEqual([a.orderId, b.orderId]);
    expect(q.body.items[0].voted).toBeNull();
    const order = (await api(h, 'GET', `/v1/orders/${a.orderId}`)).body as Order;
    const r = await api(h, 'POST', `/v1/orders/${a.orderId}/votes`, { json: signVote(101, order, 'approve'), token: s.token });
    expect(r.status).toBe(200);
    q = await api(h, 'GET', '/v1/review', { token: s.token });
    expect(q.body.items[0]).toMatchObject({ voted: 'approve', approval: { approvals: 1, declines: 0 } });
    expect(q.body.items[1].voted).toBeNull();
  });

  it('one vote per address per order; the recipient cannot vote on their own order', async () => {
    const h = makeHarness();
    // recipient seed 101 is also member #1
    const b = await inReview(h, 101);
    const self = await castVote(h, 101, b.orderId, 'approve');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('self_vote');
    expect((await castVote(h, 102, b.orderId, 'approve')).status).toBe(200);
    const again = await castVote(h, 102, b.orderId, 'decline');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_voted');
    const votes = (await api(h, 'GET', `/v1/orders/${b.orderId}/votes`)).body as VotesResponse;
    expect(votes.approval).toMatchObject({ approvals: 1, declines: 0 });
  });

  it('the vote must be the exact statement, signed by the session address (BIP-322)', async () => {
    const h = makeHarness();
    const b = await inReview(h);
    const s = await signIn(h, 101);
    const order = (await api(h, 'GET', `/v1/orders/${b.orderId}`)).body as Order;
    const good = signVote(101, order, 'approve');
    // statement for a different order
    const other = await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: { ...signVote(101, { ...order, id: 'dgt_other' }, 'approve') }, token: s.token });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('vote_invalid');
    // vote field disagrees with the statement
    const flip = await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: { ...good, vote: 'decline' }, token: s.token });
    expect(flip.status).toBe(422);
    // signed by another member's key
    const forged = await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: { ...good, signature: signBip322Simple(regtestKey(102), 'p2tr', good.message) }, token: s.token });
    expect(forged.status).toBe(422);
    expect(forged.body.error.message).toContain('signature');
    // malformed
    expect((await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: { vote: 'yes', message: '', signature: '%%' }, token: s.token })).status).toBe(422);
    expect((await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: good })).status).toBe(401);
    // the honest vote works and is independently verifiable from the public record
    const ok = await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: good, token: s.token });
    expect(ok.status).toBe(200);
    const pub = (await api(h, 'GET', `/v1/orders/${b.orderId}/votes`)).body as VotesResponse;
    expect(pub.votes).toHaveLength(1);
    expect(pub.votes[0]).toMatchObject({ degent: 1, vote: 'approve', message: good.message, signature: good.signature });
    expect(JSON.stringify(pub)).not.toContain(regtestAddress(101));
  });

  it('a holder session whose Degent was sold cannot vote', async () => {
    const h = makeHarness();
    const b = await inReview(h);
    const s = await signIn(h, 103);
    h.holders.transfer(3, regtestAddress(61));
    const r = await castVote(h, 103, b.orderId, 'approve', s.token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_a_holder');
  });

  it('votes are refused before member_review and after it', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    const early = await castVote(h, 101, b.orderId, 'approve');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('review_closed');
    await fundAndApprove(h, b);
    const late = await castVote(h, 104, b.orderId, 'approve');
    expect(late.status).toBe(409);
    expect((await api(h, 'GET', `/v1/orders/${b.orderId}/votes`)).body.votes).toHaveLength(3);
  });

  it('quorum assigns Degent numbers in approval order, persisted and monotonic', async () => {
    const h = makeHarness();
    const a = await inReview(h, 42);
    const b = await inReview(h, 43);
    const c = await inReview(h, 44);
    await membersApprove(h, b.orderId);
    await membersApprove(h, a.orderId);
    expect((await api(h, 'GET', `/v1/orders/${b.orderId}`)).body.degentNumber).toBe(4113);
    expect((await api(h, 'GET', `/v1/orders/${a.orderId}`)).body.degentNumber).toBe(4114);
    expect(await h.store.getMeta('approval.approvedCount')).toBe('2');
    // a decline in between does not consume a number
    for (const seed of MEMBER_SEEDS.slice(0, 3)) await castVote(h, seed, c.orderId, 'decline');
    expect((await api(h, 'GET', `/v1/orders/${c.orderId}`)).body).toMatchObject({ status: 'declined', degentNumber: null });
    const d = await inReview(h, 45);
    await membersApprove(h, d.orderId);
    expect((await api(h, 'GET', `/v1/orders/${d.orderId}`)).body.degentNumber).toBe(4115);
    const ev = h.events.events.filter((e) => e.orderId === d.orderId && e.status === 'queued')[0]!;
    expect(ev.previousStatus).toBe('member_review');
    expect(ev.detail).toContain('Degent #4115');
  });

  it('a configurable quorum of 1 and mixed votes', async () => {
    const h = makeHarness({ settings: { approval: { approvalQuorum: 2, declineQuorum: 1, reviewSlaSeconds: 86_400, gallerySize: 4112 } } });
    const a = await inReview(h, 42);
    expect((await castVote(h, 101, a.orderId, 'approve')).body.status).toBe('member_review');
    expect((await castVote(h, 102, a.orderId, 'approve')).body.status).toBe('queued');
    const b = await inReview(h, 43);
    expect((await castVote(h, 101, b.orderId, 'decline')).body.status).toBe('declined');
  });
});
