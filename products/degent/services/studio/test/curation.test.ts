/** House curation (ADR-0012): featuredRank orders the gallery front room, then featured, then newest. */
import { describe, expect, it } from 'vitest';
import { api, makeHarness, signIn, submit, type Harness, type Session } from './fakes/harness.js';
import { jpeg } from './fakes/images.js';

async function seed(h: Harness, s: Session, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await submit(h, s, { title: `#${i}`, bytes: jpeg(1024, 1024, 210_000, 300 + i) })).artworkId);
    h.clock.advance(60);
  }
  return ids;
}

const feature = (h: Harness, id: string, json: unknown) => api(h, 'POST', `/v1/artworks/${id}/feature`, { apiKey: h.reviewerKey, json });
const gallery = async (h: Harness) => ((await api(h, 'GET', '/v1/artworks')).body.items as Array<{ id: string }>).map((a) => a.id);

describe('POST /v1/artworks/{id}/feature with rank', () => {
  it('orders featuredRank ascending (unranked last), then featured, then newest', async () => {
    const h = makeHarness();
    const s = await signIn(h, 1);
    const ids = await seed(h, s, 6); // ids[5] newest
    expect((await feature(h, ids[0]!, { featured: true, rank: 2 })).body).toMatchObject({ featured: true, featuredRank: 2 });
    await feature(h, ids[1]!, { featured: true, rank: 1 });
    await feature(h, ids[2]!, { featured: true }); // featured, unranked
    await feature(h, ids[3]!, { featured: true, rank: 2 }); // tie on rank: newer first
    expect(await gallery(h)).toEqual([ids[1], ids[3], ids[0], ids[2], ids[5], ids[4]]);
  });

  it('a rank left out is kept, null clears it, unfeaturing clears it', async () => {
    const h = makeHarness();
    const s = await signIn(h, 2);
    const ids = await seed(h, s, 3);
    await feature(h, ids[0]!, { featured: true, rank: 5 });
    expect((await feature(h, ids[0]!, { featured: true })).body.featuredRank).toBe(5);
    expect((await feature(h, ids[0]!, { featured: true, rank: null })).body).toMatchObject({ featured: true, featuredRank: null });
    await feature(h, ids[0]!, { featured: true, rank: 3 });
    expect((await feature(h, ids[0]!, { featured: false })).body).toMatchObject({ featured: false, featuredRank: null, featuredAt: null });
    expect(await gallery(h)).toEqual([ids[2], ids[1], ids[0]]);
  });

  it('validates rank: 1..1000 integers, needs featured: true', async () => {
    const h = makeHarness();
    const s = await signIn(h, 3);
    const [id] = await seed(h, s, 1);
    for (const json of [{ featured: true, rank: 0 }, { featured: true, rank: 1001 }, { featured: true, rank: 1.5 }, { featured: true, rank: '1' }, { featured: false, rank: 1 }]) {
      const r = await feature(h, id!, json);
      expect(r.status, JSON.stringify(json)).toBe(422);
      expect(r.body.error.code).toBe('validation_failed');
    }
    expect((await feature(h, id!, { featured: true, rank: 1000 })).status).toBe(200);
    expect((await feature(h, id!, { featured: false, rank: null })).status).toBe(200);
    expect((await api(h, 'POST', `/v1/artworks/${id}/feature`, { json: { featured: true, rank: 1 } })).status).toBe(401);
  });

  it('the rank is public on the artwork and appears in the config limits', async () => {
    const h = makeHarness();
    const s = await signIn(h, 4);
    const [id] = await seed(h, s, 1);
    await feature(h, id!, { featured: true, rank: 7 });
    expect((await api(h, 'GET', `/v1/artworks/${id}`)).body.featuredRank).toBe(7);
    expect((await api(h, 'GET', '/v1/config')).body).toMatchObject({ featuredRankMax: 1000, maxEditionsLimit: 10_000, appealMessageMaxChars: 1000, appealsPerArtwork: 3 });
  });
});
