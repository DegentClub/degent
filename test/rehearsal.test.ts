/**
 * scripts/rehearsal/run.mjs proven without a network: the runner drives the mint service's in-memory app
 * (the same harness the service's own tests use: fake regtest chain, fake clock, capturing broadcasters),
 * while the test plays the humans (wallet, members, miner) for the manual scenarios.
 */
import { describe, expect, it } from 'vitest';
import type { Order } from '@bsh/degent-mint-sdk';
// @ts-expect-error plain ESM script without type declarations
import { fixturePng, parseArgs, runRehearsal, sha256Hex, taprootAddress, timingsFromTimeline } from '../scripts/rehearsal/run.mjs';
import {
  api,
  browserMintToPayment,
  browserRescue,
  castVote,
  fundAndApprove,
  fundToReview,
  makeHarness,
  type BrowserMint,
  type Harness,
} from '../products/degent/services/mint/test/fakes/harness.js';
import scenariosJson from '../scripts/rehearsal/scenarios.json' with { type: 'json' };

interface Scenario { name: string; mode: 'auto' | 'manual'; wallet?: string; device?: string; lane?: string; expect?: { status: string } }
interface ScenarioResult { name: string; mode: string; wallet: string | null; lane: string | null; result: string; reason?: string; orderId?: string; timings?: Record<string, number | string | null>; checks?: Array<{ name: string; ok: boolean }> }
interface Report { version: number; network: string; summary: Record<string, number>; scenarios: ScenarioResult[] }

const scenarios = scenariosJson as { scenarios: Scenario[] };
const BASE = 'http://mint.test/api';
const fetchFor = (h: Harness) => (url: string, init: RequestInit) => h.app.request(url.slice(BASE.length), init);
const byName = (r: Report, n: string) => r.scenarios.find((s) => s.name === n)!;
const getOrder = async (h: Harness, id: string) => (await api(h, 'GET', `/v1/orders/${id}`)).body as Order;

/** The rest of the happy path after approval: reveal, confirm, ord indexes the bytes, delivered. */
async function revealAndDeliver(h: Harness, b: BrowserMint) {
  h.clock.advance(60);
  await h.worker.tick(); // queued -> revealing -> revealed
  h.clock.advance(600);
  h.chain.mine();
  await h.worker.tick(); // revealed -> confirmed
  const o = await getOrder(h, b.orderId);
  h.chain.inscriptions.set(o.inscriptionId!, b.bytes);
  h.clock.advance(30);
  await h.worker.tick(); // verified -> delivered
}

async function deliveredOrder(h: Harness) {
  const b = await browserMintToPayment(h);
  h.clock.advance(120);
  await fundToReview(h, b); // paid -> confirming -> member_review (confirmed commit)
  h.clock.advance(3600);
  const { membersApprove } = await import('../products/degent/services/mint/test/fakes/harness.js');
  await membersApprove(h, b.orderId);
  await revealAndDeliver(h, b);
  return b;
}

describe('rehearsal helpers', () => {
  it('taprootAddress is BIP-350 bech32m (generator point vector)', () => {
    expect(taprootAddress('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'mainnet')).toBe(
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    );
    expect(taprootAddress('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'signet')).toMatch(/^tb1p[02-9ac-hj-np-z]{58}$/);
  });

  it('fixturePng has the exact size, a PNG signature and the declared dimensions', () => {
    const img: Uint8Array = fixturePng(1024, 768, 200_500);
    expect(img.length).toBe(200_500);
    expect([...img.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(img.buffer, img.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([1024, 768]);
    expect(sha256Hex(img)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('timings follow the public timeline: pay -> confirm -> approve -> delivered', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const t = timingsFromTimeline([
      { status: 'awaiting_payment', at: at(0) },
      { status: 'paid', at: at(10) },
      { status: 'confirming', at: at(10) },
      { status: 'member_review', at: at(70) },
      { status: 'queued', at: at(170) },
      { status: 'revealed', at: at(180) },
      { status: 'delivered', at: at(400) },
    ]);
    expect(t).toMatchObject({ payToConfirmSec: 60, confirmToApproveSec: 100, approveToDeliveredSec: 230, payToDeliveredSec: 390 });
  });

  it('parses the CLI arguments', () => {
    const a = parseArgs(['--base-url', 'http://x/api', '--order', 'approve=dgt_1', '--only', 'smoke,approve', '--auto', '--wait', '--out', 'r.json']);
    expect(a).toMatchObject({ baseUrl: 'http://x/api', orders: { approve: 'dgt_1' }, only: ['smoke', 'approve'], autoOnly: true, wait: true, out: 'r.json' });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

describe('scenarios.json', () => {
  it('lists the rehearsal matrix: 5 wallets x desktop/mobile, approve, decline->rescue, SLA->rescue, block lane, lane outage, policy refusal', () => {
    const names = scenarios.scenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    const wallets = scenarios.scenarios.filter((s) => s.name.startsWith('wallet-'));
    expect(wallets).toHaveLength(10);
    expect(new Set(wallets.map((s) => s.wallet))).toEqual(new Set(['unisat', 'xverse', 'leather', 'okx', 'magiceden']));
    expect(new Set(wallets.map((s) => s.device))).toEqual(new Set(['desktop', 'mobile']));
    for (const n of ['smoke', 'approve', 'decline-rescue', 'sla-rescue', 'block-lane', 'lane-outage', 'policy-refusal']) expect(names).toContain(n);
    for (const s of scenarios.scenarios.filter((x) => x.mode === 'manual')) expect(s.expect?.status, s.name).toBeTruthy();
  });
});

describe('runRehearsal against the in-memory mint', () => {
  it('auto scenarios pass: health, config, fees, create + upload with a fixture, intake refusals', async () => {
    const h = makeHarness();
    await h.ready;
    const report: Report = await runRehearsal({ baseUrl: BASE, scenarios, fetch: fetchFor(h), autoOnly: true });
    expect(report.network).toBe('regtest');
    for (const s of report.scenarios) expect(s.mode).toBe('auto');
    expect(report.scenarios.map((s) => [s.name, s.result, s.reason])).toEqual([
      ['smoke', 'pass', undefined],
      ['intake-standard', 'pass', undefined],
      ['intake-block', 'pass', undefined],
      ['policy-refusal', 'pass', undefined],
    ]);
    expect(byName(report, 'policy-refusal').checks!.map((c) => c.name)).toContain('refusal:art_rejected');
    const created = byName(report, 'intake-standard').orderId!;
    expect((await getOrder(h, created)).status).toBe('approved');
    expect(byName(report, 'intake-block').lane).toBe('block');
    expect(report.summary).toMatchObject({ pass: 4, fail: 0 });
  });

  it('smoke fails when the service is degraded (chain backend down)', async () => {
    const h = makeHarness();
    await h.ready;
    h.chain.getTipHeight = async () => {
      throw new Error('esplora down');
    };
    const report: Report = await runRehearsal({ baseUrl: BASE, scenarios, fetch: fetchFor(h), only: ['smoke'] });
    expect(byName(report, 'smoke')).toMatchObject({ result: 'fail', reason: 'health' });
  });

  it('manual scenarios without an order id are pending, not failed', async () => {
    const h = makeHarness();
    await h.ready;
    const report: Report = await runRehearsal({ baseUrl: BASE, scenarios, fetch: fetchFor(h), only: ['approve', 'wallet-xverse-mobile'] });
    expect(report.scenarios.map((s) => s.result)).toEqual(['pending', 'pending']);
    expect(byName(report, 'wallet-xverse-mobile')).toMatchObject({ wallet: 'xverse', lane: 'standard' });
    expect(report.summary.fail).toBe(0);
  });

  it('approve / wallet scenarios: a delivered, parent-linked order passes with pay->confirm->approve->delivered timings', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await deliveredOrder(h);
    const report: Report = await runRehearsal({
      baseUrl: BASE,
      scenarios,
      fetch: fetchFor(h),
      orders: { approve: b.orderId, 'wallet-unisat-desktop': b.orderId },
      only: ['approve', 'wallet-unisat-desktop'],
    });
    for (const n of ['approve', 'wallet-unisat-desktop']) {
      const s = byName(report, n);
      expect(s.result, `${n}: ${s.reason}`).toBe('pass');
      expect(s.orderId).toBe(b.orderId);
      expect(s.timings).toMatchObject({ payToConfirmSec: 0, confirmToApproveSec: 3600, approveToDeliveredSec: 690, payToDeliveredSec: 4290 });
    }
    expect(byName(report, 'wallet-unisat-desktop').wallet).toBe('unisat');
  });

  it('decline -> rescue passes only when the child landed without the parent', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    await fundToReview(h, b);
    h.clock.advance(600);
    for (const seed of [101, 102, 103]) expect((await castVote(h, seed, b.orderId, 'decline')).status).toBe(200);
    const { tx } = await browserRescue(h, b);
    h.chain.acceptRaw(tx.hex);
    h.clock.advance(60);
    await h.worker.tick(); // declined -> revealed (rescued)
    h.chain.mine();
    await h.worker.tick();
    const o = await getOrder(h, b.orderId);
    h.chain.inscriptions.set(o.inscriptionId!, b.bytes);
    await h.worker.tick();
    expect((await getOrder(h, b.orderId)).status).toBe('delivered');

    const other = await deliveredOrder(h);
    const report: Report = await runRehearsal({
      baseUrl: BASE,
      scenarios,
      fetch: fetchFor(h),
      orders: { 'decline-rescue': b.orderId, 'sla-rescue': other.orderId },
      only: ['decline-rescue', 'sla-rescue'],
    });
    expect(byName(report, 'decline-rescue').result).toBe('pass');
    expect(byName(report, 'decline-rescue').timings).toMatchObject({ declinedAt: expect.any(String), approvedAt: null });
    // A parent-linked delivery is not an SLA rescue.
    const sla = byName(report, 'sla-rescue');
    expect(sla.result).toBe('fail');
    expect(sla.reason).toContain('rescued');
    expect(report.summary.fail).toBe(1);
  });

  it('--wait polls an in-progress order until it is delivered (the test plays wallet, members and miner)', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h);
    await fundAndApprove(h, b);
    let polls = 0;
    const sleep = async () => {
      polls++;
      if (polls === 1) await h.worker.tick(); // revealed
      if (polls === 2) {
        h.chain.mine();
        await h.worker.tick(); // confirmed
      }
      if (polls === 3) {
        h.chain.inscriptions.set((await getOrder(h, b.orderId)).inscriptionId!, b.bytes);
        await h.worker.tick(); // delivered
      }
    };
    const report: Report = await runRehearsal({ baseUrl: BASE, scenarios, fetch: fetchFor(h), orders: { approve: b.orderId }, only: ['approve'], wait: true, pollMs: 1, sleep });
    expect(byName(report, 'approve').result).toBe('pass');
    expect(polls).toBe(3);
  });

  it('--wait gives up after the scenario timeout with a failed result naming the stuck status', async () => {
    const h = makeHarness();
    await h.ready;
    const b = await browserMintToPayment(h); // never paid
    let t = 0;
    const report: Report = await runRehearsal({
      baseUrl: BASE,
      scenarios,
      fetch: fetchFor(h),
      orders: { approve: b.orderId },
      only: ['approve'],
      wait: true,
      now: () => t,
      sleep: async () => {
        t += 60 * 60_000;
      },
    });
    const s = byName(report, 'approve');
    expect(s.result).toBe('fail');
    expect(s.reason).toMatch(/timeout after 240 min in awaiting_payment/);
  });

  it('an unknown order id fails the scenario', async () => {
    const h = makeHarness();
    await h.ready;
    const report: Report = await runRehearsal({ baseUrl: BASE, scenarios, fetch: fetchFor(h), orders: { approve: 'dgt_nope' }, only: ['approve'] });
    expect(byName(report, 'approve')).toMatchObject({ result: 'fail', reason: expect.stringContaining('HTTP 404') });
  });
});
