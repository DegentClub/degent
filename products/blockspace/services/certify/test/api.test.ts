import { beforeEach, describe, expect, it } from 'vitest';
import { FakeOrd } from '../src/adapters/fake-ord.js';
import { verifyAttestation } from '../src/domain/attestation.js';
import { manifestInscriptionBody, type Manifest } from '../src/domain/manifest.js';
import { itemsDigest } from '../src/domain/stats.js';
import type { Attestation, Item } from '../src/domain/model.js';
import { ADMIN, PARENT, bytes, conforms, iid, sha, spec, txid, world, type World } from './helpers.js';

/**
 * The degent-like world: a parent with five listed children over three pages (page size 2).
 * C3 is listed by ord's children index but its own record does not name the parent: excluded.
 */
function degentOrd(): FakeOrd {
  const ord = new FakeOrd({ height: 900_000, pageSize: 2 });
  ord.add({ id: PARENT, number: 90_000_000, height: 820_000, content: bytes(10) });
  const kids: [string, number, number][] = [
    ['C1', 124_000_003, 300_000],
    ['C2', 124_000_001, 100_000],
    ['C3', 124_000_002, 999_999],
    ['C4', 124_000_004, 400_000],
    ['C5', 124_000_005, 200_000],
  ];
  for (const [tag, number, size] of kids) {
    ord.add({ id: iid(tag), number, height: 890_000, content: bytes(size), parents: tag === 'C3' ? [] : [PARENT] });
    ord.listChild(PARENT, iid(tag));
    ord.vsizes.set(txid(tag), Math.ceil(size / 4) + 150);
  }
  return ord;
}

const degent = { slug: 'degent', name: 'Decentralized Gentlemen Club', parentInscriptionId: PARENT };

describe('contract coverage', () => {
  it('every operation in the contract is served, and nothing else under /v1', async () => {
    const w = world([degent], degentOrd());
    const routes = w.app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`);
    const documented = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(new Set(routes)).toEqual(new Set(documented));
  });
});

describe('meta endpoints', () => {
  it('GET /v1/health ok, then degraded when ord is down', async () => {
    const w = world([degent], degentOrd());
    let body = await conforms('GET', '/v1/health', await w.req('GET', '/v1/health'));
    expect(body).toMatchObject({ status: 'ok', service: 'blockspace-certify', keyId: w.signer.keyId, checks: { ord: { ok: true } } });
    w.ord.down = true;
    const res = await w.req('GET', '/v1/health');
    expect(res.status).toBe(200);
    body = await conforms('GET', '/v1/health', res);
    expect(body.status).toBe('degraded');
  });

  it('GET /v1/keys publishes the x-only key', async () => {
    const w = world([degent], degentOrd());
    const res = await w.req('GET', '/v1/keys');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await conforms('GET', '/v1/keys', res);
    expect(body.keys).toEqual([
      {
        keyId: w.signer.keyId,
        algorithm: 'bip340-schnorr-secp256k1',
        publicKey: Buffer.from(w.signer.publicKey).toString('hex'),
        tag: 'block.space/collection-attestation/v1',
        status: 'active',
      },
    ]);
  });

  it('edge behaviour: request id, security headers, CORS, JSON 404', async () => {
    const w = world([degent], degentOrd());
    const res = await w.app.request('/v1/keys', { headers: { 'x-request-id': 'abc-123', origin: 'https://degent.club' } });
    expect(res.headers.get('x-request-id')).toBe('abc-123');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const nf = await w.req('GET', '/nope');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: { code: 'not_found', message: 'no such endpoint' } });
  });
});

describe('parent → children certification', () => {
  let w: World;
  beforeEach(() => {
    w = world([degent], degentOrd());
  });

  it('404 not_certified before the first refresh; 404 unknown; 400 malformed slug', async () => {
    let res = await w.req('GET', '/v1/collections/degent');
    expect(res.status).toBe(404);
    expect((await conforms('GET', '/v1/collections/degent', res)).error.code).toBe('not_certified');
    res = await w.req('GET', '/v1/collections/nope');
    expect((await conforms('GET', '/v1/collections/nope', res)).error.code).toBe('collection_not_found');
    res = await w.req('GET', '/v1/collections/Bad_Slug');
    expect(res.status).toBe(400);
    await conforms('GET', '/v1/collections/Bad_Slug', res);
  });

  it('refresh requires the admin token', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token-xxxxxxxxxxxx' }, { authorization: ADMIN }] as Record<string, string>[]) {
      const res = await w.req('POST', '/v1/collections/degent/refresh', { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect((await conforms('POST', '/v1/collections/degent/refresh', res)).error.code).toBe('unauthorized');
    }
    expect(w.ord.calls).toEqual([]); // nothing ran
  });

  it('pages through 3 pages of children, excludes the child without a parent link, signs verifiable stats', async () => {
    const res = await w.refresh();
    expect(res.status).toBe(200);
    const body = await conforms('POST', '/v1/collections/degent/refresh', res);
    const a = body.attestation as Attestation;

    expect(w.ord.calls.filter((c) => c.startsWith('children'))).toEqual([`children ${PARENT} 0`, `children ${PARENT} 1`, `children ${PARENT} 2`]);
    expect(a.collection).toEqual({ slug: 'degent', name: 'Decentralized Gentlemen Club', parentInscriptionId: PARENT });
    expect(a.method).toBe('parent-children');
    expect(a.sources).toEqual([{ type: 'parent-children', parentInscriptionId: PARENT, pages: 3, listed: 5, accepted: 4, excluded: 1 }]);
    expect(body.exclusions).toEqual([
      {
        inscriptionId: iid('C3'),
        source: 'parent-children',
        reason: 'parent_link_missing',
        detail: 'listed as a child by ord, but its inscription record does not name the parent',
      },
    ]);
    expect(a.stats).toMatchObject({
      itemCount: 4,
      excludedCount: 1,
      totalContentBytes: 1_000_000,
      minItemBytes: 100_000,
      maxItemBytes: 400_000,
      medianItemBytes: 250_000,
      firstInscriptionNumber: 124_000_001,
      lastInscriptionNumber: 124_000_005,
      revealTxCount: 4,
      totalRevealVbytes: 25_150 + 75_150 + 100_150 + 50_150,
    });
    expect(a.asOfBlockHeight).toBe(900_000);
    expect(a.issuedAt).toBe('2026-09-23T12:00:00.000Z');

    // verify exactly as a third party would: key from /v1/keys, attestation from GET
    const keys = await (await w.req('GET', '/v1/keys')).json();
    const got = await conforms('GET', '/v1/collections/degent', await w.req('GET', '/v1/collections/degent'));
    expect(got).toEqual(body);
    expect(verifyAttestation(got.attestation, keys.keys[0].publicKey)).toEqual({ ok: true });
    const tampered = structuredClone(got.attestation);
    tampered.stats.itemCount = 4112;
    expect(verifyAttestation(tampered, keys.keys[0].publicKey).ok).toBe(false);
  });

  it('items: keyset pagination in (number, id) order, digest matches the attestation', async () => {
    await w.refresh();
    const seen: Item[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = `/v1/collections/degent/items?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const page: { items: Item[]; nextCursor: string | null; itemsDigest: string; asOfBlockHeight: number; slug: string } = await conforms('GET', path, await w.req('GET', path));
      expect(page.slug).toBe('degent');
      expect(page.asOfBlockHeight).toBe(900_000);
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen.map((i) => i.number)).toEqual([124_000_001, 124_000_003, 124_000_004, 124_000_005]);
    expect(seen.every((i) => i.sources.join() === 'parent-children')).toBe(true);
    const a = (await (await w.req('GET', '/v1/collections/degent')).json()).attestation as Attestation;
    expect(itemsDigest(seen)).toBe(a.stats.itemsDigest);
  });

  it('items: bad cursor / limit → 400; before refresh → 404', async () => {
    let res = await w.req('GET', '/v1/collections/degent/items');
    expect(res.status).toBe(404);
    await conforms('GET', '/v1/collections/degent/items', res);
    await w.refresh();
    for (const q of ['cursor=%%%', 'cursor=bm90LWpzb24', 'limit=0', 'limit=501', 'limit=abc']) {
      res = await w.req('GET', `/v1/collections/degent/items?${q}`);
      expect(res.status, q).toBe(400);
      await conforms('GET', `/v1/collections/degent/items?${q}`, res);
    }
  });

  it('is reproducible: same chain + same clock → identical attestation and digest (signature uses BIP340 aux randomness)', async () => {
    const strip = (b: { attestation: Attestation }) => ({ ...b, attestation: { ...b.attestation, signature: '' } });
    const a = await (await w.refresh()).json();
    const b = await (await w.refresh()).json();
    expect(strip(b)).toEqual(strip(a));
    const other = world([degent], degentOrd());
    const c = await (await other.refresh()).json();
    expect(strip(c)).toEqual(strip(a));
    expect(c.digest).toBe(a.digest);
    for (const x of [a, b, c]) expect(verifyAttestation(x.attestation, Buffer.from(w.signer.publicKey).toString('hex')).ok).toBe(true);
  });

  it('children inscribed after asOfBlockHeight are excluded (snapshot consistency)', async () => {
    w.ord.add({ id: iid('late'), number: 124_000_009, height: 900_001, content: bytes(5), parents: [PARENT] });
    w.ord.listChild(PARENT, iid('late'));
    const body = await (await w.refresh()).json();
    expect(body.exclusions).toContainEqual({ inscriptionId: iid('late'), source: 'parent-children', reason: 'after_as_of_height', detail: 'height 900001 > 900000' });
    expect(body.attestation.stats.itemCount).toBe(4);
  });

  it('reveal vbytes are null when any reveal cannot be sized', async () => {
    w.ord.vsizes.delete(txid('C4'));
    const s = (await (await w.refresh()).json()).attestation.stats;
    expect([s.totalRevealVbytes, s.revealTxCount]).toEqual([null, null]);
  });

  it('409 while a refresh is running; 502 when ord fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = w.ord.blockHeight.bind(w.ord);
    w.ord.blockHeight = async () => {
      await gate;
      return orig();
    };
    const first = w.refresh();
    const second = await w.refresh();
    expect(second.status).toBe(409);
    expect((await conforms('POST', '/v1/collections/degent/refresh', second)).error.code).toBe('refresh_in_progress');
    release();
    expect((await first).status).toBe(200);

    w.ord.down = true;
    const failed = await w.refresh();
    expect(failed.status).toBe(502);
    expect((await conforms('POST', '/v1/collections/degent/refresh', failed)).error.code).toBe('upstream_error');
    // the previous attestation is still served
    expect((await w.req('GET', '/v1/collections/degent')).status).toBe(200);
  });

  it('422 when the configured parent does not exist', async () => {
    const x = world([{ ...degent, parentInscriptionId: iid('ghost') }], degentOrd());
    const res = await x.refresh();
    expect(res.status).toBe(422);
    expect((await conforms('POST', '/v1/collections/degent/refresh', res)).error.code).toBe('parent_not_found');
  });
});

describe('legacy manifest source', () => {
  const L = ['L1', 'L2', 'L3', 'L4', 'L5'];
  function manifestWorld(opts: { inscribeAsChild: boolean; allowUnverified?: boolean; tamper?: (m: Manifest) => void } = { inscribeAsChild: true }) {
    const ord = degentOrd();
    L.forEach((tag, k) => {
      ord.add({ id: iid(tag), number: 93_832_030 + k, height: 780_000 + k, content: bytes(205_000 + k * 1000, k + 1) });
      ord.vsizes.set(txid(tag), 60_000 + k);
    });
    const manifest: Manifest = {
      collection: 'degent',
      items: [
        { inscriptionId: iid('L1') },
        { inscriptionId: iid('L2'), sha256: sha(bytes(206_000, 2)), contentLength: 206_000 },
        { inscriptionId: iid('L3'), sha256: sha('something else') }, // wrong hash
        { inscriptionId: iid('L4'), contentLength: 1 }, // wrong length
        { inscriptionId: iid('missing') }, // not on chain
        { inscriptionId: iid('C3') }, // excluded from the parent source, but a legacy member
      ],
    };
    opts.tamper?.(manifest);
    const body = new TextEncoder().encode(manifestInscriptionBody(manifest));
    const mid = iid('manifest');
    ord.add({ id: mid, number: 124_100_000, height: 895_000, content: body, contentType: 'application/json', parents: opts.inscribeAsChild ? [PARENT] : [] });
    const cfg = { ...degent, manifest: { inscriptionId: mid }, allowUnverifiedManifest: opts.allowUnverified ?? false };
    return { w: world([cfg], ord), manifest, mid };
  }

  it('an inscribed manifest that is a child of the parent is verified; its items are checked one by one', async () => {
    const { w, manifest, mid } = manifestWorld();
    const body = await conforms('POST', '/v1/collections/degent/refresh', await w.refresh());
    const a = body.attestation as Attestation;
    expect(a.method).toBe('parent-children+manifest');
    expect(a.sources[1]).toEqual({ type: 'manifest', manifestInscriptionId: mid, manifestSha256: sha(manifestInscriptionBody(manifest)), verified: true, listed: 6, accepted: 3, excluded: 3 });
    expect(body.exclusions.map((e: { inscriptionId: string; reason: string }) => [e.inscriptionId, e.reason])).toEqual(
      [
        [iid('L3'), 'sha256_mismatch'],
        [iid('L4'), 'content_length_mismatch'],
        [iid('missing'), 'not_found'],
      ].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)),
    );
    // C3 is a member via the manifest, so its parent-source exclusion is not reported
    expect(a.stats.itemCount).toBe(4 + 3);
    expect(a.stats.firstInscriptionNumber).toBe(93_832_030);
    const items = (await (await w.req('GET', '/v1/collections/degent/items?limit=500')).json()).items as Item[];
    expect(items.find((i) => i.inscriptionId === iid('C3'))!.sources).toEqual(['manifest']);
    expect(items[0]!.inscriptionId).toBe(iid('L1'));
    expect(verifyAttestation(a, Buffer.from(w.signer.publicKey).toString('hex')).ok).toBe(true);
  });

  it('a manifest NOT inscribed as a child of the parent is reported unverified and not counted', async () => {
    const { w } = manifestWorld({ inscribeAsChild: false });
    const a = (await (await w.refresh()).json()).attestation as Attestation;
    expect(a.sources[1]).toMatchObject({ type: 'manifest', verified: false, listed: 6, accepted: 0, excluded: 0 });
    expect(a.stats.itemCount).toBe(4);
  });

  it('allowUnverifiedManifest counts it anyway (preview), still flagged verified:false in the signed sources', async () => {
    const { w } = manifestWorld({ inscribeAsChild: false, allowUnverified: true });
    const a = (await (await w.refresh()).json()).attestation as Attestation;
    expect(a.sources[1]).toMatchObject({ verified: false, accepted: 3 });
    expect(a.stats.itemCount).toBe(7);
  });

  it('an off-chain manifest file (not yet inscribed) is unverified', async () => {
    const ord = degentOrd();
    const w = world([{ ...degent, manifest: { document: { collection: 'degent', items: [{ inscriptionId: iid('C3') }] } } }], ord);
    const a = (await (await w.refresh()).json()).attestation as Attestation;
    expect(a.sources[1]).toMatchObject({ manifestInscriptionId: null, verified: false, accepted: 0 });
  });

  it('manifest-only collections work without a parent (never verified)', async () => {
    const ord = degentOrd();
    const w = world([{ slug: 'legacy', name: 'Legacy', manifest: { document: { collection: 'legacy', items: [{ inscriptionId: iid('C1') }] } }, allowUnverifiedManifest: true }], ord);
    const a = (await (await w.refresh('legacy')).json()).attestation as Attestation;
    expect(a.method).toBe('manifest');
    expect(a.collection.parentInscriptionId).toBeNull();
    expect(a.stats.itemCount).toBe(1);
  });

  it('422 for an inscribed manifest that is invalid, for another collection, or missing', async () => {
    const wrongCollection = manifestWorld({ inscribeAsChild: true, tamper: (m) => (m.collection = 'other') });
    let res = await wrongCollection.w.refresh();
    expect(res.status).toBe(422);
    expect((await conforms('POST', '/v1/collections/degent/refresh', res)).error.code).toBe('manifest_invalid');

    const ord = degentOrd();
    ord.add({ id: iid('junk'), number: 1, height: 1, content: new TextEncoder().encode('{"collection":"degent","items":[{"inscriptionId":"x"}]}'), parents: [PARENT] });
    res = await world([{ ...degent, manifest: { inscriptionId: iid('junk') } }], ord).refresh();
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('manifest_invalid');

    res = await world([{ ...degent, manifest: { inscriptionId: iid('nowhere') } }], degentOrd()).refresh();
    expect(res.status).toBe(422);
    expect((await conforms('POST', '/v1/collections/degent/refresh', res)).error.code).toBe('manifest_not_found');
  });
});
