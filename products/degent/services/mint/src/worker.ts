/**
 * The mint worker. `tick()` is deterministic given its ports (chain, clock, broadcasters): it
 * reads state, advances every order as far as the chain allows, and returns. `run()` just calls
 * tick on an interval. One tick at a time: the parent UTXO chain is strictly serial.
 *
 *   awaiting_payment --(commit seen with exact value/script)--> paid --> queued
 *   queued --(lane slot + parent lease)--> revealing --attachParent/policy-sign/finalize/broadcast--> revealed
 *   revealed --(N confirmations)--> confirmed --(ord bytes sha256 == order)--> verified --> delivered
 *   pre-paid past expiry --> expired ; paid/queued/revealing past rescueAfter --> rescue_available
 *   rescue_available --(commit spent on chain)--> revealed (rescued unless it was our parent reveal)
 *
 * Lane rules:
 *   block:    one reveal in flight (revealing or revealed-unconfirmed) => one per block.
 *   standard: up to `standardConcurrency` in flight, chained on unconfirmed parents, but never on a
 *             parent created by an unconfirmed BLOCK reveal (standard relays do not have it).
 */
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import {
  addressToScript,
  attachParent,
  finalizeReveal,
  inscriptionIdFromReveal,
} from '@bsh/inscription';
import type { Lane, OrderStatus } from '@bsh/degent-mint-sdk';
import { sha256Hex } from '@bsh/degent-mint-sdk';
import type { OrderService } from './application/order-service.js';
import type { Logger } from './application/logger.js';
import { silentLogger } from './application/logger.js';
import { PolicyViolation, StaleWriteError } from './domain/errors.js';
import type { OrderRecord } from './domain/order.js';
import type { LaneBroadcasters } from './ports/broadcaster.js';
import type { ChainPort } from './ports/chain.js';
import type { Clock } from './ports/clock.js';
import type { ContentStore } from './ports/content-store.js';
import type { OrderStore } from './ports/order-store.js';
import type { ParentUtxo, ParentUtxoProvider } from './ports/parent-utxo.js';
import type { PolicySigner } from './ports/policy-signer.js';
import type { RevealVault } from './ports/reveal-vault.js';

export interface WorkerDeps {
  orders: OrderService;
  store: OrderStore;
  content: ContentStore;
  reveals: RevealVault;
  chain: ChainPort;
  parents: ParentUtxoProvider;
  signer: PolicySigner;
  broadcasters: LaneBroadcasters;
  clock: Clock;
  log?: Logger;
}

export interface TickReport {
  transitions: Array<{ orderId: string; from: OrderStatus; to: OrderStatus }>;
  errors: Array<{ orderId: string; step: string; error: string }>;
}

export class MintWorker {
  private readonly log: Logger;
  private running = false;
  private report: TickReport = { transitions: [], errors: [] };

  constructor(private readonly d: WorkerDeps) {
    this.log = d.log ?? silentLogger;
  }

  private get s() {
    return this.d.orders.settings;
  }
  private nowMs(): number {
    return this.d.clock.now().getTime();
  }

  private async move(r: OrderRecord, to: OrderStatus, opts: Parameters<OrderService['transition']>[2] = {}): Promise<OrderRecord> {
    const saved = await this.d.orders.transition(r, to, opts);
    this.report.transitions.push({ orderId: r.id, from: r.status, to });
    this.log.info('order transition', { orderId: r.id, from: r.status, to, detail: opts.detail, txid: opts.txid });
    return saved;
  }

  /** Run `fn` per order; one order's failure never stops the tick. */
  private async each(step: string, statuses: readonly OrderStatus[], fn: (r: OrderRecord) => Promise<void>): Promise<void> {
    for (const r of await this.d.store.listByStatus(statuses)) {
      try {
        await fn(r);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.report.errors.push({ orderId: r.id, step, error });
        if (!(e instanceof StaleWriteError)) this.log.error('worker step failed', { orderId: r.id, step, error });
      }
    }
  }

  async tick(): Promise<TickReport> {
    if (this.running) return { transitions: [], errors: [] };
    this.running = true;
    this.report = { transitions: [], errors: [] };
    try {
      await this.detectPayments();
      await this.expireUnpaid();
      await this.enqueuePaid();
      await this.recoverRevealing();
      await this.rescueTimeouts();
      await this.dispatch();
      await this.trackConfirmations();
      await this.verifyAndDeliver();
      await this.watchRescues();
      return this.report;
    } finally {
      this.running = false;
    }
  }

  /** Tick every `intervalMs` until the signal aborts. */
  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const rep = await this.tick().catch((e) => {
        this.log.error('tick failed', { error: e instanceof Error ? e.message : String(e) });
        return null;
      });
      if (rep && rep.transitions.length) this.log.info('tick', { transitions: rep.transitions.length, errors: rep.errors.length });
      await new Promise<void>((res) => {
        const t = setTimeout(res, intervalMs);
        signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
      });
    }
  }

  // ------------------------------------------------------------ payment + expiry

  private commitScriptHex(r: OrderRecord): string {
    return bytesToHex(addressToScript(r.quote!.commitAddress!, this.s.network));
  }

  private async detectPayments(): Promise<void> {
    const windowMs = this.s.latePaymentWindowSeconds * 1000;
    await this.each('detect-payment', ['awaiting_payment', 'expired'], async (r) => {
      if (!r.commitOutpoint || !r.hasReveal || !r.quote?.commitAddress) return;
      if (r.status === 'expired' && this.nowMs() > Date.parse(r.expiresAt) + windowMs) return;
      const tx = await this.d.chain.getTx(r.commitOutpoint.txid);
      if (!tx) return;
      const out = tx.vout[r.commitOutpoint.vout];
      const valueOk = out?.value === BigInt(r.quote.commitValueSats);
      const scriptOk = out?.scriptHex.toLowerCase() === this.commitScriptHex(r);
      if (!valueOk || !scriptOk) {
        const detail = !out
          ? `commit tx has no output ${r.commitOutpoint.vout}`
          : !scriptOk
            ? 'commit output pays a different script than the quoted commit address'
            : `commit output value ${out.value} != quoted ${r.quote.commitValueSats}`;
        if (r.status === 'awaiting_payment') await this.move(r, 'failed', { detail, txid: tx.txid });
        else this.log.warn('late commit does not match order', { orderId: r.id, detail });
        return;
      }
      const paidAt = this.d.clock.now().toISOString();
      let paid = await this.move(r, 'paid', {
        detail: tx.confirmed ? 'commit confirmed' : 'commit seen in mempool',
        txid: tx.txid,
        patch: { paidAt },
      });
      const fee = r.quote.serviceFeeSats;
      if (fee > 0 && r.serviceFeeAddress) {
        const paidFee = tx.vout.filter((o) => o.address === r.serviceFeeAddress).reduce((a, o) => a + o.value, 0n);
        if (paidFee < BigInt(fee)) {
          // Funds are safe in the commit, but we will not co-sign without the fee: offer self-rescue now.
          paid = await this.move(paid, 'rescue_available', { detail: `service fee not paid (${paidFee} < ${fee} sats)` });
        }
      }
    });
  }

  private async expireUnpaid(): Promise<void> {
    await this.each('expire', ['awaiting_content', 'reviewing', 'approved', 'awaiting_payment'], async (r) => {
      if (this.nowMs() <= Date.parse(r.expiresAt)) return;
      await this.move(r, 'expired', { detail: 'quote expired before payment was seen' });
    });
  }

  private async enqueuePaid(): Promise<void> {
    await this.each('enqueue', ['paid'], async (r) => {
      await this.move(r, 'queued', { detail: `${r.lane} lane`, patch: { queuedAt: r.paidAt ?? this.d.clock.now().toISOString() } });
    });
  }

  // ------------------------------------------------------------ reveal

  private async onRevealSeen(r: OrderRecord, parentValue: bigint | null): Promise<void> {
    const parent = await this.d.parents.current();
    const leasedBy = await this.d.parents.leasedBy();
    if (leasedBy === r.id && parent) {
      await this.d.parents.advance(r.id, {
        txid: r.revealTxid!,
        vout: 0,
        value: parentValue ?? parent.value,
        scriptHex: bytesToHex(addressToScript(this.s.collectionAddress, this.s.network)),
        confirmed: false,
        createdByLane: r.lane,
      });
    }
    await this.move(r, 'revealed', { detail: `broadcast via ${r.lane} lane`, txid: r.revealTxid!, patch: { lastError: null } });
  }

  /** Broadcast an order already in `revealing` with a finalized tx. Returns true on success. */
  private async broadcastRevealing(r: OrderRecord, parentValue: bigint | null): Promise<boolean> {
    const res = await this.d.broadcasters[r.lane].broadcast(r.revealHex!);
    if (res.ok) {
      if (res.txid !== r.revealTxid) this.log.warn('broadcaster returned a different txid', { orderId: r.id, via: res.via });
      await this.onRevealSeen(r, parentValue);
      return true;
    }
    this.log.warn('broadcast failed', { orderId: r.id, lane: r.lane, via: res.via, error: res.error, retryable: res.retryable });
    if (res.retryable) {
      // Keep the lease and the exact tx: retrying the same bytes is idempotent.
      await this.d.orders.patch(r, { broadcastAttempts: r.broadcastAttempts + 1, lastError: res.error });
      return false;
    }
    if (await this.d.chain.getTx(r.revealTxid!)) {
      await this.onRevealSeen(r, parentValue);
      return true;
    }
    await this.d.parents.release(r.id);
    await this.move(r, 'queued', {
      detail: `broadcast rejected: ${res.error.slice(0, 200)}`,
      patch: {
        broadcastAttempts: r.broadcastAttempts + 1,
        lastError: res.error,
        revealHex: null,
        revealTxid: null,
        revealWeight: null,
        inscriptionId: null,
        parentOutpoint: null,
      },
    });
    return false;
  }

  /** Crash/retry recovery for orders left in `revealing`. */
  private async recoverRevealing(): Promise<void> {
    await this.each('recover-revealing', ['revealing'], async (r) => {
      if (!r.revealHex || !r.revealTxid) {
        await this.d.parents.release(r.id);
        await this.move(r, 'queued', { detail: 'reveal was not finalized; requeued', patch: { parentOutpoint: null } });
        return;
      }
      if (await this.d.chain.getTx(r.revealTxid)) {
        await this.onRevealSeen(r, null);
        return;
      }
      await this.broadcastRevealing(r, null);
    });
  }

  private async rescueTimeouts(): Promise<void> {
    const after = this.s.collection.rescueAfterSeconds * 1000;
    await this.each('rescue-timeout', ['paid', 'queued', 'revealing'], async (r) => {
      if (!r.paidAt || this.nowMs() - Date.parse(r.paidAt) < after) return;
      if (r.status === 'revealing') {
        if (r.revealTxid && (await this.d.chain.getTx(r.revealTxid))) {
          await this.onRevealSeen(r, null);
          return;
        }
        await this.d.parents.release(r.id);
      }
      await this.move(r, 'rescue_available', {
        detail: `not revealed within ${this.s.collection.rescueAfterSeconds}s; self-rescue (no parent) is available`,
      });
    });
  }

  private async dispatch(): Promise<void> {
    const occ = await this.d.orders.laneOccupancy();
    const inFlight: Record<Lane, number> = { standard: occ.standard.inFlight.length, block: occ.block.inFlight.length };
    const capacity: Record<Lane, number> = { standard: this.s.standardConcurrency, block: 1 };
    const candidates = [...occ.standard.waiting, ...occ.block.waiting]
      .filter((o) => o.status === 'queued')
      .sort((a, b) => `${a.queuedAt}|${a.id}`.localeCompare(`${b.queuedAt}|${b.id}`));
    for (const o of candidates) {
      if (inFlight[o.lane] >= capacity[o.lane]) continue;
      if (await this.d.parents.leasedBy()) return; // a reveal is mid-flight on the parent
      const parent = await this.d.parents.current();
      if (!parent) {
        this.log.error('no parent UTXO configured; cannot reveal', {});
        return;
      }
      if (o.lane === 'standard' && !parent.confirmed && parent.createdByLane === 'block') continue;
      try {
        if (await this.reveal(o)) inFlight[o.lane]++;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.report.errors.push({ orderId: o.id, step: 'dispatch', error });
        this.log.error('dispatch failed', { orderId: o.id, error });
      }
    }
  }

  private async reveal(o: OrderRecord): Promise<boolean> {
    const lease = await this.d.parents.lease(o.id);
    if (!lease) return false;
    let r: OrderRecord;
    try {
      r = await this.move(o, 'revealing', { patch: { parentOutpoint: { txid: lease.txid, vout: lease.vout } } });
    } catch (e) {
      await this.d.parents.release(o.id);
      throw e;
    }
    let finalized: ReturnType<typeof finalizeReveal>;
    try {
      finalized = await this.buildSignedReveal(r, lease);
    } catch (e) {
      await this.d.parents.release(r.id);
      if (e instanceof PolicyViolation) {
        // Refused and logged by the signer. The user's commit is intact: offer self-rescue.
        await this.move(r, 'rescue_available', { detail: 'parent co-signature refused by policy; self-rescue available' });
        return false;
      }
      const error = e instanceof Error ? e.message : String(e);
      await this.move(r, 'queued', { detail: 'reveal construction failed; will retry', patch: { lastError: error, parentOutpoint: null } });
      throw e;
    }
    if (finalized.weight !== r.quote!.revealWeight)
      this.log.error('reveal weight differs from quote', { orderId: r.id, quoted: r.quote!.revealWeight, actual: finalized.weight });
    r = await this.d.orders.patch(r, {
      revealHex: finalized.hex,
      revealTxid: finalized.txid,
      revealWeight: finalized.weight,
      inscriptionId: inscriptionIdFromReveal(finalized.txid, 0),
    });
    return this.broadcastRevealing(r, lease.value);
  }

  private async buildSignedReveal(r: OrderRecord, lease: ParentUtxo) {
    const psbt = await this.d.reveals.get(r.id);
    if (!psbt) throw new Error('half-signed reveal missing from vault');
    const quote = r.quote!;
    const attached = attachParent({
      network: this.s.network,
      halfSignedPsbtBase64: psbt,
      parentOutpoint: { txid: lease.txid, vout: lease.vout },
      parentValue: lease.value,
      parentScript: hexToBytes(lease.scriptHex),
      parentReturnAddress: this.s.collectionAddress,
    });
    const signed = await this.d.signer.sign({
      orderId: r.id,
      psbtBase64: attached.psbtBase64,
      context: {
        lane: r.lane,
        parentOutpoint: { txid: lease.txid, vout: lease.vout },
        parentValue: lease.value,
        parentScript: hexToBytes(lease.scriptHex),
        commitOutpoint: r.commitOutpoint!,
        commitValue: BigInt(quote.commitValueSats),
        commitScript: hexToBytes(this.commitScriptHex(r)),
        recipientScript: addressToScript(r.recipientAddress, this.s.network),
        postage: BigInt(quote.postageSats),
        quotedFeeRate: quote.feeRate,
        expectedWeight: quote.revealWeight,
      },
    });
    return finalizeReveal(signed.psbtBase64);
  }

  // ------------------------------------------------------------ after broadcast

  private async trackConfirmations(): Promise<void> {
    const parent = await this.d.parents.current();
    if (parent && !parent.confirmed) {
      const ptx = await this.d.chain.getTx(parent.txid).catch(() => null);
      if (ptx?.confirmed) await this.d.parents.markConfirmed(parent.txid);
    }
    let tip: number | null = null;
    await this.each('confirmations', ['revealed'], async (r) => {
      const tx = await this.d.chain.getTx(r.revealTxid!);
      if (!tx) {
        // Dropped from mempools: re-push our own reveal (a user's rescue tx is theirs to push).
        if (r.revealHex && !r.rescued) await this.d.broadcasters[r.lane].broadcast(r.revealHex);
        return;
      }
      if (!tx.confirmed || tx.blockHeight === null) return;
      tip ??= await this.d.chain.getTipHeight();
      if (tip - tx.blockHeight + 1 < this.s.confirmations) return;
      if (!r.rescued) await this.d.parents.markConfirmed(tx.txid);
      await this.move(r, 'confirmed', { detail: `block ${tx.blockHeight}`, txid: tx.txid });
    });
  }

  private async verifyAndDeliver(): Promise<void> {
    await this.each('verify', ['confirmed'], async (r) => {
      const bytes = await this.d.chain.getInscriptionContent(r.inscriptionId!);
      if (!bytes) return; // ord has not indexed it yet
      const sha = sha256Hex(bytes);
      if (sha !== r.contentSha256) {
        await this.move(r, 'failed', { detail: `ord content sha256 ${sha} != ${r.contentSha256}` });
        return;
      }
      await this.move(r, 'verified', { detail: 'ord content sha256 matches' });
    });
    await this.each('deliver', ['verified'], async (r) => {
      const tx = await this.d.chain.getTx(r.revealTxid!);
      if (!tx) return;
      const childIndex = r.rescued ? 0 : 1;
      const out = tx.vout[childIndex];
      const expected = bytesToHex(addressToScript(r.recipientAddress, this.s.network));
      if (out?.scriptHex.toLowerCase() !== expected) {
        this.log.error('child output does not pay the recipient', { orderId: r.id, txid: tx.txid });
        return;
      }
      await this.move(r, 'delivered', { detail: `child at ${tx.txid}:${childIndex}`, txid: tx.txid });
    });
  }

  private async watchRescues(): Promise<void> {
    await this.each('watch-rescue', ['rescue_available'], async (r) => {
      if (!r.commitOutpoint) return;
      const spends = await this.d.chain.getTxOutspends(r.commitOutpoint.txid);
      const spend = spends?.[r.commitOutpoint.vout];
      if (!spend?.spent || !spend.txid) return;
      const ours = r.revealTxid !== null && spend.txid === r.revealTxid;
      if (ours) {
        // Our parent reveal landed after all: the parent moved with it.
        const parent = await this.d.parents.current();
        if (parent && r.parentOutpoint && parent.txid === r.parentOutpoint.txid && parent.vout === r.parentOutpoint.vout) {
          if (await this.d.parents.lease(r.id)) {
            await this.d.parents.advance(r.id, {
              txid: spend.txid,
              vout: 0,
              value: parent.value,
              scriptHex: parent.scriptHex,
              confirmed: false,
              createdByLane: r.lane,
            });
          }
        }
      }
      await this.move(r, 'revealed', {
        detail: ours ? 'parent reveal confirmed on chain' : 'self-rescue reveal seen on chain (no parent link)',
        txid: spend.txid,
        patch: {
          revealTxid: spend.txid,
          inscriptionId: inscriptionIdFromReveal(spend.txid, 0),
          rescued: !ours,
          ...(ours ? {} : { revealHex: null }),
        },
      });
    });
  }
}
