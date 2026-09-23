import type { FeesResponse } from '@bsh/degent-mint-sdk';

/** Current fee environment for the quote UI. Adapters: esplora /fee-estimates, static. */
export interface FeePort {
  getFees(): Promise<Omit<FeesResponse, 'network' | 'minFeeRate'>>;
}
