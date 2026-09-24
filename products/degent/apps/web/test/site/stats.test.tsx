import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderSite } from './helpers';
import { createCertifiedCollection, createCertifiedStats, parseCollectionAttestation, parseItemsPage } from '../../src/site/services/real/certify';
import { bundledStats } from '../../src/site/services/bundled';
import type { CollectionStats } from '../../src/site/services/types';

const CERTIFIED: CollectionStats = {
  source: 'certified',
  supply: 10_000,
  minted: 1234,
  bytes: 567_000_000,
  certifiedHeight: 866_123,
  certifiedAt: '2026-09-20T12:00:00Z',
};

/** The live site's hardcoded / conflicting numbers must never appear. */
const HARDCODED = ['4,027', '4027', '1470MB', '1,470', '3+ GB', '40.27%', '47.85%'];

describe('header meters bind to StatsService only', () => {
  it('render the certified numbers with a "certified at block" tooltip', async () => {
    renderSite('/', { site: { stats: CERTIFIED } });
    expect(await screen.findByTestId('meter-minted')).toHaveTextContent('1,234 / 10K');
    expect(screen.getByTestId('meter-bytes')).toHaveTextContent('567 MB / 3 GB');
    expect(screen.getByTestId('meters')).toHaveTextContent('12.34%');
    expect(screen.getByTestId('meters')).toHaveTextContent('18.90%');
    expect(screen.getByTestId('meters-tip')).toHaveTextContent('Certified by block.space at block 866,123 (2026-09-20)');
    expect(screen.getByTestId('bar-minted')).toHaveAttribute('aria-valuenow', '12.34');
    // the compact strip is bound to the same numbers
    expect(screen.getByTestId('strip-meter-minted')).toHaveTextContent('1,234 / 10K');
    const text = document.body.textContent ?? '';
    for (const h of HARDCODED) expect(text).not.toContain(h);
  });

  it('the collection card shows certified numbers and a computed projection, never "10K = 3+ GB"', async () => {
    renderSite('/collection', { site: { stats: CERTIFIED } });
    const card = await screen.findByTestId('collection-stats');
    expect(within(card).getByTestId('card-minted')).toHaveTextContent('1,234');
    expect(within(card).getByTestId('card-bytes')).toHaveTextContent('567 MB');
    // 567 MB / 1234 x 10,000 = 4.59 GB
    expect(within(card).getByTestId('card-projected')).toHaveTextContent('~4.6 GB');
    expect(screen.getByTestId('card-provenance')).toHaveTextContent(/projection extrapolates/);
    for (const h of HARDCODED) expect(document.body.textContent).not.toContain(h);
  });

  it('show "unavailable" (and no number) when certification fails', async () => {
    renderSite('/collection', { site: { stats: new Error('certification API 503') } });
    expect(await screen.findAllByText('Collection stats unavailable')).not.toHaveLength(0);
    expect(screen.getByTestId('card-minted')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('card-projected')).toHaveTextContent('unavailable');
  });

  it('demo labels the bundled manifest as not certified', async () => {
    renderSite('/', { site: {} });
    await screen.findByTestId('meter-minted');
    expect(screen.getByTestId('meters')).toHaveAttribute('data-source', 'bundled');
    expect(screen.getByTestId('meters-tip')).toHaveTextContent('Bundled manifest snapshot: not certified (demo)');
  });
});

describe('certification API parsing', () => {
  it('reads nested attestation stats (snake_case)', () => {
    const s = parseCollectionAttestation({
      slug: 'degents',
      supply: 10000,
      attestation: { block_height: 866000, issued_at: '2026-09-20T00:00:00Z', stats: { count: 4113, total_bytes: 1_508_000_000 } },
    });
    expect(s).toEqual({ source: 'certified', supply: 10000, minted: 4113, bytes: 1_508_000_000, certifiedHeight: 866000, certifiedAt: '2026-09-20T00:00:00Z' });
  });

  it('reads camelCase at the top level', () => {
    const s = parseCollectionAttestation({ collection: { latestAttestation: { blockHeight: 1, itemCount: 2, contentBytes: 3 } } });
    expect(s).toMatchObject({ minted: 2, bytes: 3, certifiedHeight: 1, supply: 10000 });
  });

  it('refuses to guess when counts are missing', () => {
    expect(() => parseCollectionAttestation({ attestation: { height: 1 } })).toThrow(/no item count/);
    expect(() => parseCollectionAttestation('x')).toThrow();
  });

  it('parses item pages and cursors', () => {
    const p = parseItemsPage({ items: [{ inscription_id: 'a'.repeat(64) + 'i0', number: 7, content_length: 300000 }, { bogus: 1 }], next_cursor: 'c2' });
    expect(p).toEqual({ items: [{ id: 'a'.repeat(64) + 'i0', number: 7, name: 'Degent #7', size_kb: 300 }], next: 'c2' });
  });

  it('follows cursors for the membership list and calls the right URLs', async () => {
    const urls: string[] = [];
    const pages: Record<string, unknown> = {
      'https://c.test/v1/collections/degents/items': { items: [{ id: 'b'.repeat(64) + 'i0', number: 2 }], next_cursor: 'p2' },
      'https://c.test/v1/collections/degents/items?cursor=p2': { items: [{ id: 'a'.repeat(64) + 'i0', number: 1 }], next_cursor: null },
    };
    const fetch = async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify(pages[u]), { status: 200 });
    };
    const list = await createCertifiedCollection({ baseUrl: 'https://c.test', slug: 'degents', fetch }).list();
    expect(list.source).toBe('certified');
    expect(list.items.map((i) => i.number)).toEqual([1, 2]);
    expect(urls).toEqual(Object.keys(pages));
  });

  it('stats: GET /v1/collections/degents; no fallback in production, bundled fallback in demo', async () => {
    const urls: string[] = [];
    const fail = async (u: string) => {
      urls.push(u);
      return new Response('{}', { status: 503 });
    };
    await expect(createCertifiedStats({ baseUrl: 'https://c.test', slug: 'degents', fetch: fail }).getStats()).rejects.toThrow(/503/);
    expect(urls).toEqual(['https://c.test/v1/collections/degents']);
    await expect(createCertifiedStats({ baseUrl: '', slug: 'degents' }).getStats()).rejects.toThrow(/not configured/);
    const demo = await createCertifiedStats({ baseUrl: '', slug: 'degents', fallbackToBundled: true }).getStats();
    expect(demo).toEqual(await bundledStats());
  });

  it('the bundled summary is computed from the 4,112-entry snapshot', async () => {
    const s = await bundledStats();
    expect(s.source).toBe('bundled');
    expect(s.minted).toBe(4112);
    expect(Math.round(s.bytes / 1_000_000)).toBe(1508);
  });
});
