/** Real MintApi: delegates to @bsh/degent-mint-sdk's typed client (contracts/openapi/degent-mint.yaml). */
import { createMintClient, etaMinutesForPosition, type FetchLike } from '@bsh/degent-mint-sdk';
import type { FeeSnapshot, MintApi, QueueSnapshot } from '../types';

export function createRealMintApi(baseUrl: string, fetchImpl?: FetchLike): MintApi {
  const client = createMintClient(fetchImpl ? { baseUrl, fetch: fetchImpl } : { baseUrl });
  return {
    getConfig: () => client.config(),
    async getFees(): Promise<FeeSnapshot> {
      const f = await client.fees();
      return {
        economy: f.standard.slow,
        normal: f.standard.normal,
        priority: f.standard.fast,
        minimum: f.minFeeRate,
        blockRecommended: f.block.recommended,
        updatedAt: f.fetchedAt,
      };
    },
    async getQueue(): Promise<QueueSnapshot> {
      const q = await client.queue();
      const blockAhead = q.block.waiting + q.block.inFlight;
      return {
        blockLaneLength: blockAhead,
        blockLaneEtaMinutes: etaMinutesForPosition(blockAhead + 1) ?? (blockAhead + 1) * 10,
        standardLaneLength: q.standard.waiting + q.standard.inFlight,
      };
    },
    createOrder: (req) => client.createOrder(req),
    uploadContent: (id, bytes) => client.uploadContent(id, bytes),
    submitReveal: (id, req) => client.submitReveal(id, req),
    getOrder: (id) => client.getOrder(id),
    async getRescue(id) {
      const r = await client.getRescue(id);
      return { hex: r.hex, txid: r.txid };
    },
  };
}
