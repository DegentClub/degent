import { aggregate, type LabeledReading } from './aggregate.js';
import {
  DEFAULT_AGGREGATE_CONFIG,
  type AggregateConfig,
  type FeeSource,
  type FeesResponse,
  type LanePolicy,
  type Network,
  type OutlierPolicy,
  type SourceHealth,
  type SourceReading,
  type SourcesHealthResponse,
  type TierTargets,
} from './types.js';

export interface AggregateConfigInput {
  minRelayFeeRate?: number;
  step?: number;
  tiers?: Partial<TierTargets>;
  lane?: Partial<LanePolicy>;
  outliers?: Partial<OutlierPolicy>;
}

export interface FeeOracleOptions {
  network: Network;
  sources: FeeSource[];
  config?: AggregateConfigInput;
  /** Aggregate cache TTL. Default 30 s. */
  ttlMs?: number;
  /** How long past its TTL a cached aggregate may still be served (flagged `stale`) when every refresh fails. Default 10 min. */
  maxStaleMs?: number;
  /** A source with no success for this long is reported `stale` in health. Default 5 min. */
  staleAfterMs?: number;
  /** Per-source timeout. Default 5 s. */
  timeoutMs?: number;
  now?: () => number;
}

/** Anything that can answer GET /v1/fees: the in-process oracle or a remote client. */
export interface FeeProvider {
  readonly network: Network;
  getFees(opts?: { force?: boolean }): Promise<FeesResponse>;
}

export interface FeeOracle extends FeeProvider {
  readonly config: AggregateConfig;
  /** Source health as of the last poll (does not poll). */
  health(): SourcesHealthResponse;
}

export class FeesUnavailableError extends Error {
  readonly code = 'fees_unavailable';
  constructor(message: string, readonly details: { sources: Array<{ id: string; error: string | null }> }) {
    super(message);
    this.name = 'FeesUnavailableError';
  }
}

export function resolveConfig(input: AggregateConfigInput = {}): AggregateConfig {
  const d = DEFAULT_AGGREGATE_CONFIG;
  const cfg: AggregateConfig = {
    minRelayFeeRate: input.minRelayFeeRate ?? d.minRelayFeeRate,
    step: input.step ?? d.step,
    tiers: { ...d.tiers, ...input.tiers },
    lane: { ...d.lane, ...input.lane },
    outliers: { ...d.outliers, ...input.outliers },
  };
  const pos = (n: number, name: string) => {
    if (!(Number.isFinite(n) && n > 0)) throw new Error(`${name} must be a positive number (got ${n})`);
  };
  pos(cfg.minRelayFeeRate, 'minRelayFeeRate');
  pos(cfg.step, 'step');
  pos(cfg.lane.minFeeRate, 'lane.minFeeRate');
  pos(cfg.lane.premium, 'lane.premium');
  pos(cfg.lane.maxFeeRate, 'lane.maxFeeRate');
  pos(cfg.outliers.madK, 'outliers.madK');
  if (!(cfg.outliers.minRelSpread >= 0)) throw new Error('outliers.minRelSpread must be >= 0');
  return cfg;
}

interface HealthState {
  source: FeeSource;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  outliers: string[];
  lastReading: SourceReading | null;
  ok: boolean;
}

/** Race a source against a timeout; aborts the source's signal either way. */
async function pollWithTimeout(source: FeeSource, timeoutMs: number): Promise<SourceReading> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([source.fetch(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function createFeeOracle(opts: FeeOracleOptions): FeeOracle {
  const config = resolveConfig(opts.config);
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxStaleMs = opts.maxStaleMs ?? 600_000;
  const staleAfterMs = opts.staleAfterMs ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  if (opts.sources.length === 0) throw new Error('fee oracle needs at least one source');
  const states = new Map<string, HealthState>();
  for (const source of opts.sources) {
    if (states.has(source.id)) throw new Error(`duplicate fee source id: ${source.id}`);
    states.set(source.id, {
      source,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      latencyMs: null,
      consecutiveFailures: 0,
      outliers: [],
      lastReading: null,
      ok: false,
    });
  }

  let cache: { fees: FeesResponse; builtAt: number } | null = null;
  let inflight: Promise<FeesResponse> | null = null;

  async function refresh(): Promise<FeesResponse> {
    const results = await Promise.all(
      [...states.values()].map(async (st): Promise<LabeledReading | null> => {
        const started = now();
        const t0 = performance.now();
        st.lastAttemptAt = started;
        try {
          const reading = await pollWithTimeout(st.source, timeoutMs);
          st.ok = true;
          st.lastSuccessAt = now();
          st.lastError = null;
          st.consecutiveFailures = 0;
          st.lastReading = reading;
          return { id: st.source.id, reading };
        } catch (e) {
          st.ok = false;
          st.lastError = errMsg(e);
          st.consecutiveFailures += 1;
          return null;
        } finally {
          st.latencyMs = Math.round(performance.now() - t0);
        }
      }),
    );
    const readings = results.filter((r): r is LabeledReading => r !== null);
    const agg = aggregate(readings, config);
    for (const st of states.values()) st.outliers = agg?.outliers[st.source.id] ?? [];
    const t = now();
    if (agg) {
      const fees: FeesResponse = {
        network: opts.network,
        minFeeRate: agg.minFeeRate,
        standard: agg.standard,
        block: agg.block,
        fetchedAt: new Date(t).toISOString(),
        stale: false,
        sources: agg.contributors,
      };
      cache = { fees, builtAt: t };
      return fees;
    }
    if (cache && t - cache.builtAt <= ttlMs + maxStaleMs) return { ...cache.fees, stale: true };
    throw new FeesUnavailableError(`no fee source produced usable data for ${opts.network}`, {
      sources: [...states.values()].map((s) => ({ id: s.source.id, error: s.ok ? 'no standard fee targets' : s.lastError })),
    });
  }

  return {
    network: opts.network,
    config,
    async getFees({ force = false } = {}) {
      if (!force && cache && now() - cache.builtAt < ttlMs) return cache.fees;
      if (inflight) return inflight;
      inflight = refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    health() {
      const t = now();
      const iso = (x: number | null) => (x === null ? null : new Date(x).toISOString());
      const sources: SourceHealth[] = [...states.values()].map((s) => ({
        id: s.source.id,
        kind: s.source.kind,
        ok: s.ok,
        stale: s.lastSuccessAt === null || t - s.lastSuccessAt > staleAfterMs,
        lastAttemptAt: iso(s.lastAttemptAt),
        lastSuccessAt: iso(s.lastSuccessAt),
        lastError: s.lastError,
        latencyMs: s.latencyMs,
        consecutiveFailures: s.consecutiveFailures,
        outliers: [...s.outliers],
        lastReading: s.lastReading,
      }));
      const healthy = sources.filter((s) => s.ok && !s.stale).length;
      return {
        network: opts.network,
        status: healthy === sources.length ? 'ok' : healthy === 0 ? 'down' : 'degraded',
        checkedAt: new Date(t).toISOString(),
        sources,
      };
    },
  };
}
