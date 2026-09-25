/**
 * Full Block Exhibit pages (/exhibit and /exhibit/:n), kiosk mode, JSON twin, demo labelling.
 * Everything runs on the fakes: no network.
 */
import { describe, expect, it } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import type { CollectionItem } from '../../src/site/services/types';
import { BLOCK_WEIGHT_LIMIT } from '../../src/site/lib/exhibit';
import { renderSite } from './helpers';

/** Valid-id items: a few Full Block Degents plus ordinary ones (which must be filtered out). */
function mixed(): CollectionItem[] {
  const mk = (n: number, sizeKb: number): CollectionItem => {
    const hex = n.toString(16).padStart(2, '0').repeat(32).slice(0, 64);
    return { id: `${hex}i0`, number: n, name: `Degent #${n}`, size_kb: sizeKb };
  };
  return [mk(2770, 3962.66), mk(2650, 3800), mk(2651, 3550), mk(5, 300), mk(6, 350)];
}

const FULLBLOCK_NUMBERS = [2770, 2650, 2651];

describe('/exhibit gallery', () => {
  it('lists only the Full Block Degents, largest first, labelled uncertified in demo', async () => {
    renderSite('/exhibit', { site: { items: mixed() } });
    const grid = await screen.findByTestId('exhibit-grid');
    const cards = within(grid).getAllByRole('link');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAccessibleName(/Degent #2770/);
    expect(screen.getByTestId('exhibit-source')).toHaveTextContent(/not certified, demo/);
    // the ordinary Degents are absent
    expect(within(grid).queryByText('Degent #5')).toBeNull();
  });

  it('shows an honest empty state when no full-block items exist (real certified count may be 0)', async () => {
    renderSite('/exhibit'); // default ITEMS = 45 fake standard-size Degents
    expect(await screen.findByTestId('exhibit-empty')).toHaveTextContent(/No Full Block Degents|no Full Block Degents/);
    expect(screen.queryByTestId('exhibit-grid')).toBeNull();
    // still teaches the concept
    expect(screen.getByRole('heading', { name: 'Why a full block is special' })).toBeInTheDocument();
  });

  it('never renders the retired live-site numbers', async () => {
    const { container } = renderSite('/exhibit', { site: { items: mixed() } });
    await screen.findByTestId('exhibit-grid');
    expect(container.textContent).not.toContain('4,027');
    expect(container.textContent).not.toContain('1,470');
  });
});

describe('/exhibit/:n detail', () => {
  it('renders a plate, the one-block viz to scale, facts, placard and the block.space deep links', async () => {
    renderSite('/exhibit/2770', { site: { items: mixed() } });
    expect(await screen.findByRole('heading', { level: 1, name: /Degent #2770/ })).toBeInTheDocument();

    // the one-block visualization is drawn to scale: fill width === weight / 4,000,000
    const viz = screen.getAllByTestId('one-block-viz')[0]!;
    const weight = Number(viz.getAttribute('data-weight'));
    const fraction = Number(viz.getAttribute('data-fraction'));
    expect(Number(viz.getAttribute('data-block-weight'))).toBe(BLOCK_WEIGHT_LIMIT);
    expect(fraction).toBeCloseTo(weight / BLOCK_WEIGHT_LIMIT, 10);
    const fill = within(viz).getByTestId('oneblock-fill');
    const widthPct = parseFloat((fill.style.width || '0').replace('%', ''));
    expect(widthPct).toBeCloseTo(fraction * 100, 3);

    // real numbers
    expect(screen.getByTestId('fact-content-bytes')).toHaveTextContent('3,962,660 bytes');
    expect(screen.getByTestId('fact-weight')).toHaveTextContent(`${weight.toLocaleString('en-US')} WU`);
    expect(screen.getByTestId('fact-fraction')).toHaveTextContent('of 4,000,000 WU');

    // placard
    expect(screen.getByTestId('placard-id').textContent).toMatch(/i0$/);

    // deep links — X-Ray on the reveal txid, Buy on Magic Eden; Theater once ord returns the height
    const links = screen.getByTestId('exhibit-links');
    const xray = within(links).getByRole('link', { name: /View in X-Ray/ });
    expect(xray.getAttribute('href')).toMatch(/^https:\/\/block\.space\/xray\/[0-9a-f]{64}$/);
    expect(within(links).getByRole('link', { name: /View on Ordinals.com/ })).toHaveAttribute('href', expect.stringContaining('/inscription/'));
    await waitFor(() => expect(within(links).getByRole('link', { name: /View in Block Theater/ }).getAttribute('href')).toMatch(/\/theater\?block=\d+/));
  });

  it('injects VisualArtwork JSON-LD with size/contentSize and a citation', async () => {
    renderSite('/exhibit/2770', { site: { items: mixed() } });
    await screen.findByRole('heading', { level: 1, name: /Degent #2770/ });
    const ld = document.head.querySelector('script[type="application/ld+json"]');
    expect(ld).not.toBeNull();
    const data = JSON.parse(ld!.textContent!);
    expect(data['@type']).toBe('VisualArtwork');
    expect(data.contentSize).toBe('3962660 B');
    expect(String(data.size)).toContain('4,000,000 WU');
    expect(data.citation.name).toContain('4,000,000 WU');
    expect(data.isPartOf.name).toBe('Decentralized Gentlemen Club');
  });

  it('sets a per-item share title', async () => {
    renderSite('/exhibit/2770', { site: { items: mixed() } });
    await screen.findByRole('heading', { level: 1, name: /Degent #2770/ });
    expect(document.title).toBe('Degent #2770 — Full Block Exhibit · degent.club');
  });

  it('an ordinary Degent number is honestly not in the exhibit', async () => {
    renderSite('/exhibit/5', { site: { items: mixed() } });
    expect(await screen.findByText(/is not a Full Block Degent/)).toBeInTheDocument();
    expect(screen.queryByTestId('one-block-viz')).toBeNull();
  });
});

describe('kiosk mode (?kiosk=1)', () => {
  it('shows a full-screen auto-advancing plate with the one-block viz', async () => {
    renderSite('/exhibit?kiosk=1', { site: { items: mixed() } });
    const kiosk = await screen.findByTestId('kiosk');
    expect(within(kiosk).getByTestId('kiosk-plate')).toBeInTheDocument();
    expect(within(kiosk).getAllByTestId('one-block-viz').length).toBeGreaterThan(0);
    expect(within(kiosk).getByRole('link', { name: 'Exit kiosk' })).toHaveAttribute('href', expect.stringContaining('/exhibit'));
  });
});

describe('machine-native JSON twin (?format=json)', () => {
  it('the index twin is valid JSON with the full-block items and demo labelling', async () => {
    renderSite('/exhibit?format=json', { site: { items: mixed() } });
    const pre = await screen.findByTestId('json-twin');
    const data = JSON.parse(pre.textContent!);
    expect(data.count).toBe(3);
    expect(data.source).toBe('bundled');
    expect(data.certified).toBe(false);
    expect(data.items.map((x: { number: number }) => x.number)).toEqual(FULLBLOCK_NUMBERS);
    expect(data.blockWeightLimitWU).toBe(4_000_000);
  });

  it('the per-item twin is valid JSON with estimated:true', async () => {
    renderSite('/exhibit/2770?format=json', { site: { items: mixed() } });
    const pre = await screen.findByTestId('json-twin');
    const data = JSON.parse(pre.textContent!);
    expect(data.number).toBe(2770);
    expect(data.estimated).toBe(true);
    expect(data.tier).toBe('fullblock');
  });
});

describe('navigation', () => {
  it('the slide-out menu links to the Exhibit', async () => {
    renderSite('/', { site: { items: mixed() } });
    const teaser = await screen.findByTestId('exhibit-teaser');
    expect(within(teaser).getByRole('link', { name: /Enter the Exhibit/ })).toHaveAttribute('href', expect.stringContaining('/exhibit'));
  });
});
