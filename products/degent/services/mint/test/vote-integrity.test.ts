/**
 * Security regressions for member approval (ADR-0007; docs/security/findings.json DGT-SEC-001..004).
 * One vote per member and per Degent, whatever the address spelling; quorum and numbering hold
 * under concurrent votes.
 */
import { describe, expect, it } from 'vitest';
import { signBip322Simple } from '@bsh/identity';
import type { AuthVerifyResponse, Order, VotesResponse } from '@bsh/degent-mint-sdk';
import {
  api,
  browserMintToPayment,
  castVote,
  fundToReview,
  makeHarness,
  regtestAddress,
  regtestKey,
  signIn,
  signVote,
  type Harness,
} from './fakes/harness.js';

/** Like esplora, answer holder lookups by script: an address in any bech32 case is the same holder. */
function scriptKeyedHolders(h: Harness): void {
  const orig = h.holders.isHolder.bind(h.holders);
  h.holders.isHolder = (address: string) => orig(/^(bc|tb|bcrt)1/i.test(address) ? address.toLowerCase() : address);
}

/** SIWB sign-in with an arbitrary spelling of the member's address. */
async function signInAs(h: Harness, seed: number, address: string) {
  const ch = await api(h, 'POST', '/v1/auth/challenge', { json: { address } });
  expect(ch.status).toBe(200);
  const signature = signBip322Simple(regtestKey(seed), 'p2tr', ch.body.message);
  const signedAddress = /\n(\S+)\n/.exec(ch.body.message)![1]!;
  const v = await api(h, 'POST', '/v1/auth/verify', { json: { address: signedAddress, message: ch.body.message, signature } });
  return { challenge: ch.body.message as string, verify: v };
}

const order = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

describe('DGT-SEC-001: addresses are canonical (bech32 case)', () => {
  it('a member cannot vote twice by signing in with the upper-case form of the same address', async () => {
    const h = makeHarness();
    scriptKeyedHolders(h);
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    expect((await castVote(h, 101, b.orderId, 'approve')).status).toBe(200);

    const upper = regtestAddress(101).toUpperCase();
    const s = await signInAs(h, 101, upper);
    // The challenge binds the canonical (lower-case) address, so the session is the same member.
    expect(s.challenge).toContain(regtestAddress(101));
    expect(s.challenge).not.toContain(upper);
    expect(s.verify.status).toBe(200);
    const session = s.verify.body as AuthVerifyResponse;
    expect(session.address).toBe(regtestAddress(101));
    const second = await api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: signVote(101, await order(h, b.orderId), 'approve'), token: session.token });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_voted');
    expect((await order(h, b.orderId)).approval!.approvals).toBe(1);
  });

  it('orders store the canonical recipient, so the self-vote rule cannot be dodged by case', async () => {
    const h = makeHarness();
    scriptKeyedHolders(h);
    const b = await browserMintToPayment(h, { recipientAddress: regtestAddress(101).toUpperCase() });
    expect(b.order.recipientAddress).toBe(regtestAddress(101));
    await fundToReview(h, b);
    const r = await castVote(h, 101, b.orderId, 'approve');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('self_vote');
  });
});

describe('DGT-SEC-002: every vote is backed by a distinct Degent', () => {
  it('a Degent that already voted cannot vote again from the address it was moved to', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    expect((await castVote(h, 101, b.orderId, 'approve')).status).toBe(200); // #1 votes
    h.holders.transfer(1, regtestAddress(150));
    const again = await castVote(h, 150, b.orderId, 'approve');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_voted');
    expect(again.body.error.message).toMatch(/Degent #1/);
    expect((await order(h, b.orderId)).approval!.approvals).toBe(1);
  });

  it('a member with several Degents votes once; a Degent they did not vote with may vote after a sale', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    expect((await castVote(h, 200, b.orderId, 'approve')).status).toBe(200); // holds #100 and #101, votes with #100
    h.holders.transfer(101, regtestAddress(151));
    const sold = await castVote(h, 151, b.orderId, 'decline'); // #101 never voted
    expect(sold.status).toBe(200);
    expect((sold.body as VotesResponse).votes.map((v) => v.degent).sort((x, y) => x - y)).toEqual([100, 101]);
    h.holders.transfer(100, regtestAddress(152));
    expect((await castVote(h, 152, b.orderId, 'approve')).status).toBe(409); // #100 already voted
  });
});

describe('DGT-SEC-003/004: concurrent votes', () => {
  it('concurrent final votes on two orders assign distinct Degent numbers', async () => {
    const h = makeHarness();
    const a = await browserMintToPayment(h, { recipientSeed: 61 });
    const c = await browserMintToPayment(h, { recipientSeed: 62 });
    await fundToReview(h, a);
    await fundToReview(h, c);
    for (const seed of [101, 102]) {
      expect((await castVote(h, seed, a.orderId, 'approve')).status).toBe(200);
      expect((await castVote(h, seed, c.orderId, 'approve')).status).toBe(200);
    }
    const s3 = await signIn(h, 103);
    const [oa, oc] = [await order(h, a.orderId), await order(h, c.orderId)];
    const res = await Promise.all([
      api(h, 'POST', `/v1/orders/${a.orderId}/votes`, { json: signVote(103, oa, 'approve'), token: s3.token }),
      api(h, 'POST', `/v1/orders/${c.orderId}/votes`, { json: signVote(103, oc, 'approve'), token: s3.token }),
    ]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const numbers = [(await order(h, a.orderId)).degentNumber, (await order(h, c.orderId)).degentNumber];
    expect(numbers.every((n) => n !== null)).toBe(true);
    expect(new Set(numbers).size).toBe(2);
    expect(numbers.sort()).toEqual([4113, 4114]);
  });

  it('concurrent votes that together reach the quorum approve the order (no lost quorum)', async () => {
    const h = makeHarness();
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    // Sign in one after the other (the platform's in-memory nonce store sweeps on the wall clock, the
    // harness runs on a fake one); only the votes race.
    const sessions: AuthVerifyResponse[] = [];
    for (const seed of [101, 102, 103]) sessions.push(await signIn(h, seed));
    const o = await order(h, b.orderId);
    const res = await Promise.all(
      [101, 102, 103].map((seed, i) => api(h, 'POST', `/v1/orders/${b.orderId}/votes`, { json: signVote(seed, o, 'approve'), token: sessions[i]!.token })),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    const after = await order(h, b.orderId);
    expect(after.approval!.approvals).toBe(3);
    expect(after.status).toBe('queued');
    expect(after.degentNumber).toBe(4113);
  });
});
