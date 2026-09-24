/**
 * Settlement watcher: decides the fate of every open listing from chain and ord facts (there is no
 * client "sold" call). One tick = for each `active`/`pending` listing, collect facts, apply the pure
 * `nextState`, persist + publish through the lifecycle. Upstream failures leave a listing untouched.
 */
import { hex } from '@scure/base';
import { nextState, type ChainFacts, type ListingRecord } from '../domain/listing.js';
import { decodeAddress } from '../domain/settlement/index.js';
import type { MarketChain } from '../ports/chain.js';
import type { Clock } from '../ports/clock.js';
import type { ListingStore } from '../ports/listing-store.js';
import type { OrdIndexer } from '../ports/ord.js';
import type { ListingLifecycle } from './lifecycle.js';
import type { Logger } from './logger.js';
import { silentLogger } from './logger.js';
import type { MarketSettings } from './settings.js';

export interface WatcherDeps {
  settings: MarketSettings;
  listings: ListingStore;
  chain: MarketChain;
  ord: OrdIndexer;
  lifecycle: ListingLifecycle;
  clock: Clock;
  purgeSessions?: () => Promise<number>;
  log?: Logger;
}

export interface WatcherChange {
  inscriptionId: string;
  from: string;
  to: string;
  reason: string;
  txid?: string | null;
}

export class SettlementWatcher {
  private running = false;
  private readonly log: Logger;

  constructor(private readonly d: WatcherDeps) {
    this.log = d.log ?? silentLogger;
  }

  private async inspect(l: ListingRecord): Promise<ChainFacts> {
    const [txid, vout] = l.location.split(':') as [string, string];
    const facts: ChainFacts = { outspend: await this.d.chain.getOutspend(txid, Number(vout)) };
    if (facts.outspend?.spent && facts.outspend.txid) {
      try {
        facts.spendingTx = await this.d.chain.getTx(facts.outspend.txid);
      } catch (e) {
        this.log.warn('spending tx unavailable', { inscriptionId: l.inscriptionId, error: e instanceof Error ? e.message : String(e) });
      }
    } else {
      try {
        facts.inscription = await this.d.ord.getInscription(l.inscriptionId);
      } catch (e) {
        this.log.warn('indexer unavailable', { inscriptionId: l.inscriptionId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return facts;
  }

  async tick(): Promise<{ skipped: boolean; changes: WatcherChange[] }> {
    if (this.running) return { skipped: true, changes: [] };
    this.running = true;
    const changes: WatcherChange[] = [];
    try {
      const open = await this.d.listings.listByStatus(['active', 'pending']);
      for (const l of open) {
        try {
          const facts = await this.inspect(l);
          let sellerScriptHex: string | undefined;
          try {
            sellerScriptHex = hex.encode(decodeAddress(l.sellerAddress, this.d.settings.network).script);
          } catch {
            sellerScriptHex = undefined;
          }
          const next = nextState(l, facts, { now: this.d.clock.now(), pendingTimeoutMs: this.d.settings.pendingTimeoutMs, ...(sellerScriptHex ? { sellerScriptHex } : {}) });
          if (!next) {
            await this.d.listings.save({ ...l, lastCheckedAt: this.d.clock.now().toISOString() });
            continue;
          }
          await this.d.lifecycle.transition(l, next.status, next.reason, next.txid === undefined ? {} : { txid: next.txid });
          changes.push({ inscriptionId: l.inscriptionId, from: l.status, to: next.status, reason: next.reason, ...(next.txid !== undefined ? { txid: next.txid } : {}) });
          this.log.info('listing settled by watcher', { inscriptionId: l.inscriptionId, from: l.status, to: next.status, reason: next.reason });
        } catch (e) {
          this.log.warn('listing check failed', { inscriptionId: l.inscriptionId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (this.d.purgeSessions) await this.d.purgeSessions().catch(() => 0);
    } finally {
      this.running = false;
    }
    return { skipped: false, changes };
  }

  /** Poll until `signal` aborts. */
  async run(intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick().catch((e) => this.log.error('watcher tick failed', { error: e instanceof Error ? e.message : String(e) }));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  }
}
