/**
 * Real MintApi: delegates to @bsh/degent-mint-sdk's typed client (contracts/openapi/degent-mint.yaml).
 *
 * Order-scoped calls carry `Authorization: Bearer <orderToken>` (set by the SDK client; the token
 * never appears in a URL). A missing token is refused here before any request is made.
 */
import { createMintClient, etaMinutesForPosition, type FetchLike, type Order } from '@bsh/degent-mint-sdk';
import type { CreatedOrder, FeeSnapshot, MintApi, QueueSnapshot } from '../types';

function isCreated(v: unknown): v is CreatedOrder {
  return (
    typeof v === 'object' &&
    v !== null &&
    'order' in v &&
    typeof (v as CreatedOrder).orderToken === 'string' &&
    (v as CreatedOrder).orderToken.length > 0
  );
}

export function createRealMintApi(baseUrl: string, fetchImpl?: FetchLike): MintApi {
  const client = createMintClient(fetchImpl ? { baseUrl, fetch: fetchImpl } : { baseUrl });
  const need = (orderToken: string) => {
    if (!orderToken) throw new Error('Missing order token: this order cannot be changed from this browser.');
    return orderToken;
  };
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
    async createOrder(req) {
      const res: unknown = await client.createOrder(req);
      if (!isCreated(res)) {
        throw new Error('The mint service did not return an order token. Refusing to continue with this order.');
      }
      return { order: res.order as Order, orderToken: res.orderToken };
    },
    uploadContent: async (id, token, bytes) => client.uploadContent(id, need(token), bytes),
    submitReveal: async (id, token, req) => client.submitReveal(id, need(token), req),
    getOrder: (id) => client.getOrder(id),
    getRescue: async (id, token) => client.getRescue(id, need(token)),
    subscribeOrder: async (id, token, req) => client.subscribeOrder(id, need(token), req),
    authChallenge: (address) => client.authChallenge({ address }),
    authVerify: (address, message, signature) => client.authVerify({ address, message, signature }),
    getReviewQueue: (session) => client.reviewQueue(session),
    castVote: (id, session, req) => client.castVote(id, session, req),
    getVotes: (id) => client.getVotes(id),
    getRegister: () => client.register(),
    getRegisterMember: (n) => client.registerMember(n),
    getHolder: (address) => client.registerHolder(address),
    verifyMember: (id) => client.registerVerify(id),
    getExplorer: (q) => client.explorer(q),
    getStats: () => client.stats(),
  };
}
