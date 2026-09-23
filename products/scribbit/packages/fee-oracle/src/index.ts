/**
 * @bsh/fee-oracle: multi-source Bitcoin fee aggregation for scribb.it (library).
 * The optional HTTP server lives at `@bsh/fee-oracle/server` so library users never load Hono.
 */
export * from './types.js';
export { aggregate, ceilToStep, median, rejectOutliers, type Aggregate, type LabeledReading } from './aggregate.js';
export {
  createFeeOracle,
  FeesUnavailableError,
  resolveConfig,
  type AggregateConfigInput,
  type FeeOracle,
  type FeeOracleOptions,
  type FeeProvider,
} from './oracle.js';
export { feeClient, parseFeesResponse, type FeeClientOptions } from './client.js';
export { mempoolBlocksSource, mempoolRecommendedSource, type HttpSourceOptions } from './sources/mempool.js';
export { esploraSource } from './sources/esplora.js';
export { bitcoindSource, blockLaneSource, type BitcoindSourceOptions, type BlockLaneSourceOptions } from './sources/bitcoind.js';
export { staticSource } from './sources/static.js';
export type { RpcOptions } from './sources/http.js';

/** Public mempool.space base URL per network (regtest has none). */
export function publicMempoolUrl(network: import('./types.js').Network): string | null {
  switch (network) {
    case 'mainnet':
      return 'https://mempool.space';
    case 'testnet':
      return 'https://mempool.space/testnet4';
    case 'signet':
      return 'https://mempool.space/signet';
    default:
      return null;
  }
}
