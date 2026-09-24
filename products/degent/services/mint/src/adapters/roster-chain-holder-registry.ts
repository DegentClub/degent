/**
 * HolderRegistry over the roster JSON plus the chain: the roster says which inscription ids are
 * Degents (Gallery + approved children added at runtime); ord says who holds them.
 *
 *   holderOf(n):       GET <ord>/r/inscription/<id>  -> { address }          (cached per id, TTL)
 *   isHolder(address): GET <esplora>/address/<a>/utxo -> outpoints,
 *                      GET <ord>/r/utxo/<txid:vout>   -> { inscriptions }    (cached per outpoint)
 *                      intersected with the roster's ids.
 *
 * `fetch` is injected so tests never touch the network. A failed lookup is reported as unknown
 * (null / no degents), never thrown, except for isHolder when esplora itself is unreachable.
 *
 * Upstream fan-out is bounded (the Register endpoints are public): isHolder refuses addresses with more than
 * `maxUtxos` unspent outputs (one ord call per output otherwise), concurrent lookups of the same inscription or
 * outpoint share one request, and at most `maxConcurrent` ord requests are in flight across all callers.
 */
import { DomainError } from '../domain/errors.js';
import type { HolderCheck, HolderRegistry } from '../ports/holder-registry.js';
import type { Clock } from '../ports/clock.js';
import { httpClient, trimSlash, type HttpOptions } from './http.js';

export interface RosterEntry {
  n: number;
  inscriptionId: string;
}

export interface RosterChainOptions extends HttpOptions {
  esploraUrl: string;
  ordUrl: string;
  clock?: Clock;
  /** How long an owner lookup is trusted (default 60 s; ownership changes with every block). */
  cacheSeconds?: number;
  /** isHolder refuses addresses with more unspent outputs than this (default 1,000). */
  maxUtxos?: number;
  /** Max ord requests in flight across all callers (default 16). */
  maxConcurrent?: number;
}

export const DEFAULT_MAX_HOLDER_UTXOS = 1_000;
export const DEFAULT_MAX_ORD_CONCURRENCY = 16;

/** A counting semaphore: run(fn) waits for a free slot. */
class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((ok) => this.waiting.push(ok));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface Cached<T> {
  at: number;
  value: T;
}

export class RosterChainHolderRegistry implements HolderRegistry {
  private readonly http: ReturnType<typeof httpClient>;
  private readonly esplora: string;
  private readonly ord: string;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly idToN = new Map<string, number>();
  private readonly nToId = new Map<number, string>();
  private readonly ownerCache = new Map<string, Cached<string | null>>();
  private readonly utxoCache = new Map<string, Cached<string[]>>();
  private readonly ownerInFlight = new Map<string, Promise<string | null>>();
  private readonly utxoInFlight = new Map<string, Promise<string[]>>();
  private readonly maxUtxos: number;
  private readonly ordSlots: Limiter;

  constructor(roster: readonly RosterEntry[], opts: RosterChainOptions) {
    this.http = httpClient(opts);
    this.esplora = trimSlash(opts.esploraUrl);
    this.ord = trimSlash(opts.ordUrl);
    this.clock = opts.clock ?? { now: () => new Date() };
    this.ttlMs = (opts.cacheSeconds ?? 60) * 1000;
    this.maxUtxos = opts.maxUtxos ?? DEFAULT_MAX_HOLDER_UTXOS;
    this.ordSlots = new Limiter(Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_ORD_CONCURRENCY));
    for (const m of roster) this.add(m.n, m.inscriptionId);
  }

  /** Register a newly delivered child so its holder counts as a member. */
  add(n: number, inscriptionId: string): void {
    this.idToN.set(inscriptionId, n);
    this.nToId.set(n, inscriptionId);
  }

  get size(): number {
    return this.nToId.size;
  }

  private fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
    return c !== undefined && this.clock.now().getTime() - c.at < this.ttlMs;
  }

  /** An ord GET through the shared concurrency limit. */
  private async json<T>(url: string): Promise<T | null> {
    return this.ordSlots.run(async () => {
      try {
        const res = await this.http(url, { headers: { accept: 'application/json' } });
        if (!res.ok) return null;
        return (await res.json()) as T;
      } catch {
        return null;
      }
    });
  }

  /** One request per key at a time: concurrent callers share the in-flight promise. */
  private coalesce<T>(inFlight: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key);
    if (running) return running;
    const p = fn().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  async holderOf(n: number): Promise<string | null> {
    const id = this.nToId.get(n);
    if (!id) return null;
    const c = this.ownerCache.get(id);
    if (this.fresh(c)) return c.value;
    return this.coalesce(this.ownerInFlight, id, async () => {
      const j = await this.json<{ address?: string | null }>(`${this.ord}/r/inscription/${encodeURIComponent(id)}`);
      const value = typeof j?.address === 'string' && j.address.length > 0 ? j.address : null;
      // Only cache answers: an outage must not pin "unknown" for a minute.
      if (j) this.ownerCache.set(id, { at: this.clock.now().getTime(), value });
      return value;
    });
  }

  private async inscriptionsAt(outpoint: string): Promise<string[]> {
    const c = this.utxoCache.get(outpoint);
    if (this.fresh(c)) return c.value;
    return this.coalesce(this.utxoInFlight, outpoint, async () => {
      const j = await this.json<{ inscriptions?: string[] }>(`${this.ord}/r/utxo/${encodeURIComponent(outpoint)}`);
      const value = Array.isArray(j?.inscriptions) ? j.inscriptions.filter((x): x is string => typeof x === 'string') : [];
      if (j) this.utxoCache.set(outpoint, { at: this.clock.now().getTime(), value });
      return value;
    });
  }

  async isHolder(address: string): Promise<HolderCheck> {
    const res = await this.http(`${this.esplora}/address/${encodeURIComponent(address)}/utxo`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`esplora address utxo: HTTP ${res.status}`);
    const body: unknown = await res.json();
    const utxos = (Array.isArray(body) ? body : []) as Array<{ txid: string; vout: number }>;
    if (utxos.length > this.maxUtxos)
      throw new DomainError(
        'validation_failed',
        422,
        `this address has more than ${this.maxUtxos} unspent outputs; the Register cannot check it (hold your Degent in a dedicated ordinals address)`,
      );
    const degents = new Set<number>();
    for (const u of utxos) {
      for (const id of await this.inscriptionsAt(`${u.txid}:${u.vout}`)) {
        const n = this.idToN.get(id);
        if (n !== undefined) {
          degents.add(n);
          this.ownerCache.set(id, { at: this.clock.now().getTime(), value: address });
        }
      }
    }
    return { degents: [...degents].sort((a, b) => a - b) };
  }
}
