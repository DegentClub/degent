/**
 * Site-wide data with ONE source: the mint service's Register (`/v1/stats`, `/v1/explorer`), demo fakes in
 * `?demo=1`. The header meters, Home and the Collection all read the same stats object, so the site can never
 * show two different counts again (the live site had three).
 *
 * The inscription-info cache prefetches ord details for a whole grid page, so opening the lightbox shows the
 * facts at once instead of a "LOADING…" flash.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StatsResponse } from '@bsh/degent-mint-sdk';
import type { InscriptionInfo, Services } from '../services/types';

/** "10K = 3+ GB": the club's projection for the full charter. Shown as a projection, never as a measurement. */
export const PROJECTED_CHARTER_BYTES = 3_000_000_000;

export type InfoState = { status: 'ok'; info: InscriptionInfo } | { status: 'error'; message: string } | { status: 'loading' } | undefined;

export class InscriptionInfoCache {
  private readonly entries = new Map<string, InfoState>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly fetchInfo: (id: string) => Promise<InscriptionInfo>) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = () => this.version;

  get(id: string): InfoState {
    return this.entries.get(id);
  }

  private set(id: string, s: InfoState) {
    this.entries.set(id, s);
    this.version++;
    for (const l of this.listeners) l();
  }

  load(id: string): Promise<void> {
    const cur = this.entries.get(id);
    if (cur && cur.status === 'ok') return Promise.resolve();
    const running = this.inflight.get(id);
    if (running) return running;
    this.set(id, { status: 'loading' });
    const p = this.fetchInfo(id)
      .then((info) => this.set(id, { status: 'ok', info }))
      .catch((e) => this.set(id, { status: 'error', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** Fetch many with bounded concurrency (be kind to the ord server). */
  async prefetch(ids: readonly string[], concurrency = 4): Promise<void> {
    const queue = ids.filter((id) => this.entries.get(id)?.status !== 'ok');
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.load(id);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }
}

export interface SiteData {
  stats: StatsResponse | null;
  statsError: string | null;
  info: InscriptionInfoCache;
}

const SiteContext = createContext<SiteData | null>(null);

export function SiteDataProvider({ services, children }: { services: Services; children: ReactNode }) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const cacheRef = useRef<InscriptionInfoCache | null>(null);
  if (!cacheRef.current) cacheRef.current = new InscriptionInfoCache((id) => services.chain.getInscriptionInfo(id));

  useEffect(() => {
    let alive = true;
    services.mintApi
      .getStats()
      .then((s) => {
        if (!alive) return;
        setStats(s);
        setStatsError(null);
      })
      .catch((e) => alive && setStatsError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [services]);

  const value = useMemo(() => ({ stats, statsError, info: cacheRef.current! }), [stats, statsError]);
  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteData {
  const v = useContext(SiteContext);
  if (!v) throw new Error('useSite must be used inside <SiteDataProvider>');
  return v;
}

/** ord facts for one inscription, from the prefetch cache (loads on demand). */
export function useInscriptionInfo(id: string | null): InfoState {
  const { info } = useSite();
  useSyncExternalStore(info.subscribe, info.snapshot, info.snapshot);
  const load = useCallback(() => {
    if (id) void info.load(id);
  }, [id, info]);
  useEffect(load, [load]);
  return id ? info.get(id) : undefined;
}
