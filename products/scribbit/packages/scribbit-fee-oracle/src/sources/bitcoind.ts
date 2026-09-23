import type { FeeSource, SourceReading, Target } from '../types.js';
import { btcPerKvbToSatPerVb, redact, rpcClient, type RpcOptions } from './http.js';
import { hostOf } from './mempool.js';

export interface BitcoindSourceOptions extends RpcOptions {
  id?: string;
  /** estimatesmartfee mode. Default 'conservative' (what Core's wallet uses for RBF-signalling txs). */
  estimateMode?: 'economical' | 'conservative';
}

interface SmartFee {
  feerate?: number;
  errors?: string[];
  blocks?: number;
}
interface MempoolInfo {
  mempoolminfee?: number;
  minrelaytxfee?: number;
}

/**
 * bitcoind JSON-RPC: `estimatesmartfee <target>` for every target (BTC/kvB -> sat/vB) and
 * `getmempoolinfo` for the standard-relay floor max(mempoolminfee, minrelaytxfee).
 * Targets the estimator has no data for are omitted (not an error) as long as one target is known.
 */
export function bitcoindSource(opts: BitcoindSourceOptions): FeeSource {
  const call = rpcClient(opts);
  const mode = (opts.estimateMode ?? 'conservative').toUpperCase();
  return {
    id: opts.id ?? `bitcoind:${hostOf(redact(opts.url))}`,
    kind: 'bitcoind',
    async fetch(signal) {
      const targetList = [1, 3, 6, 144] as const;
      const [info, ...estimates] = await Promise.all([
        call<MempoolInfo>('getmempoolinfo', [], signal),
        ...targetList.map((t) => call<SmartFee>('estimatesmartfee', [t, mode], signal)),
      ]);
      const targets: Partial<Record<Target, number>> = {};
      targetList.forEach((t, i) => {
        const r = btcPerKvbToSatPerVb(estimates[i]?.feerate);
        if (r !== undefined) targets[t] = r;
      });
      const floor = Math.max(btcPerKvbToSatPerVb(info?.mempoolminfee) ?? 0, btcPerKvbToSatPerVb(info?.minrelaytxfee) ?? 0);
      if (Object.keys(targets).length === 0 && floor === 0) throw new Error('bitcoind: estimator has no data');
      const reading: SourceReading = { targets };
      if (floor > 0) reading.minRelay = floor;
      return reading;
    },
  };
}

export interface BlockLaneSourceOptions extends RpcOptions {
  id?: string;
  /** estimatesmartfee target for the recommendation. Default 1 (next block; bitcoind clamps to 2). */
  target?: number;
}

/**
 * Block lane over a permissive relay node's RPC (Libre Relay, e.g. fleet `libre-mainnet`), used for
 * non-standard, block-sized reveals.
 *   block.min         = max(mempoolminfee, minrelaytxfee) of that node (what it will accept)
 *   block.recommended = estimatesmartfee(target), if the estimator has data
 * The aggregator then applies the configured `LanePolicy` (floor, premium, cap).
 */
export function blockLaneSource(opts: BlockLaneSourceOptions): FeeSource {
  const call = rpcClient(opts);
  const target = opts.target ?? 1;
  return {
    id: opts.id ?? `block-lane:${hostOf(redact(opts.url))}`,
    kind: 'block-lane',
    async fetch(signal) {
      const [info, est] = await Promise.all([
        call<MempoolInfo>('getmempoolinfo', [], signal),
        call<SmartFee>('estimatesmartfee', [target, 'CONSERVATIVE'], signal).catch(() => undefined),
      ]);
      const min = Math.max(btcPerKvbToSatPerVb(info?.mempoolminfee) ?? 0, btcPerKvbToSatPerVb(info?.minrelaytxfee) ?? 0);
      if (min === 0) throw new Error('block-lane: node reported no relay floor');
      const block: NonNullable<SourceReading['block']> = { min };
      const rec = btcPerKvbToSatPerVb(est?.feerate);
      if (rec !== undefined) block.recommended = rec;
      return { block };
    },
  };
}
