import type { RegisterMember, StatsResponse, VerifyMembershipResponse } from '@bsh/degent-mint-sdk';
import { MemoryDraftStore } from '../src/adapters/memory-draft-store.js';
import { MemoryXClient } from '../src/adapters/memory-x-client.js';
import { Publisher, type PublisherSettings } from '../src/application/publisher.js';
import type { RegisterReader } from '../src/ports/register-reader.js';

export const NOW = Date.parse('2026-09-24T12:00:00.000Z');

export function makePublisher(settings: Partial<PublisherSettings> = {}) {
  const store = new MemoryDraftStore();
  const x = new MemoryXClient();
  const publisher = new Publisher({ store, x, settings: { reviewQueueEnabled: true, postingEnabled: true, ...settings }, now: () => NOW });
  return { store, x, publisher };
}

export const INSCRIPTION = `${'ab'.repeat(32)}i0`;

export function fakeRegister(members: Record<string, RegisterMember> = {}, stats?: Partial<StatsResponse>): RegisterReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async registerVerify(id: string): Promise<VerifyMembershipResponse> {
      calls.push(`verify ${id}`);
      const m = members[id];
      return m ? { id, member: true, via: m.via, n: m.n } : { id, member: false, via: null, n: null };
    },
    async registerMember(n: number): Promise<RegisterMember> {
      calls.push(`member ${n}`);
      const m = Object.values(members).find((x) => x.n === n);
      if (!m) throw new Error(`no member ${n}`);
      return m;
    },
    async stats(): Promise<StatsResponse> {
      calls.push('stats');
      return {
        minted: 4113,
        charter: 10000,
        totalBytes: 1_512_345_678,
        medianBytes: 372_000,
        mintsPerWeek: [],
        sizeHistogram: [],
        approvals: { inReview: 0, approved: 1, declined: 0, perWeek: [], medianSecondsToQuorum: null },
        topHolders: [{ owner: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', count: 12 }],
        updatedAt: new Date(NOW).toISOString(),
        ...stats,
      };
    },
  };
}

export function member(n: number, bytes: number, height: number | null, id = INSCRIPTION): RegisterMember {
  return { n, id, number: null, via: 'child', bytes, height, sat: null, owner: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', contentUrl: `https://ordinals.com/content/${id}` };
}
