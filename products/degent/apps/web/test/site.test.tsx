/**
 * The site pages of products/degent/docs/site-spec.md ("Target information architecture"): Home, the
 * Collection (pagination, filters, lightbox with prefetched on-chain details), /collection/:n (meta + JSON-LD),
 * the Comic, How it works, the Club, the TODO(copy) pages, the chrome, and accessibility basics on every page.
 */
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { pageWindow } from '../src/pages/Collection';
import { fakes, renderApp, testApp } from './helpers';

const ID1 = `${'1'.repeat(64)}i0`;
const ID2 = `${'2'.repeat(64)}i0`;

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe('accessibility on every page', () => {
  const paths = ['/', '/collection', '/collection/17', '/comic', '/how-it-works', '/club', '/manifesto', '/about', '/mint', '/review', '/explorer', '/verify', '/track/ord_demo_missing', '/nope'];
  it.each(paths)('%s has one h1, the landmarks, and alt text on every image', async (path) => {
    const { unmount } = renderApp(fakes(), { path });
    await settle();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1));
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    for (const img of document.querySelectorAll('img')) expect(img.hasAttribute('alt'), img.outerHTML.slice(0, 80)).toBe(true);
    unmount();
  });
});

describe('global chrome', () => {
  it('header: logo home link, the two meters from /v1/stats, Mint and Buy; one stats source for the whole site', async () => {
    const log: string[] = [];
    renderApp(fakes({ log }), { path: '/' });
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'degent.club home' })).toHaveAttribute('href', '/');
    const minted = await within(header).findByRole('meter', { name: 'Degents minted of 10,000' });
    await waitFor(() => expect(minted).toHaveAttribute('aria-valuetext', '4,112 / 10K · 41.12% MINTED'));
    expect(minted).toHaveAttribute('aria-valuemax', '10000');
    const bytes = within(header).getByRole('meter', { name: 'Blockspace inscribed of the projected 3 GB' });
    expect(bytes.getAttribute('aria-valuetext')).toMatch(/^[\d,]+MB \/ 3GB · [\d.]+% INSCRIBED$/);
    expect(within(header).getByRole('link', { name: /Mint/ })).toHaveAttribute('href', '/mint');
    expect(within(header).getByRole('link', { name: /Buy/ })).toHaveAttribute('href', 'https://magiceden.io/ordinals/marketplace/degentclub');
    // Home shows the same numbers, fetched once.
    expect(await screen.findByTestId('stat-minted')).toHaveTextContent('4,112');
    expect(log.filter((l) => l === 'api.getStats')).toHaveLength(1);
  });

  it('footer: wordmark, tagline, quick links, socials, and a disabled newsletter form (no endpoint yet)', () => {
    renderApp(fakes(), { path: '/' });
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on Bitcoin.')).toBeInTheDocument();
    const quick = within(footer).getByRole('navigation', { name: 'Quick links' });
    expect(within(quick).getByRole('link', { name: 'Mint Process' })).toHaveAttribute('href', '/how-it-works');
    expect(within(footer).getByLabelText('E-mail')).toBeDisabled();
    expect(within(footer).getByRole('button', { name: 'Subscribe' })).toBeDisabled();
    expect(within(footer).getByRole('img', { name: 'Telegram' }).closest('a')).toHaveAttribute('href', 'https://t.me/+cneroYQ-0VpmM2Ix');
    expect(within(footer).queryByRole('img', { name: 'Instagram' })).not.toBeInTheDocument(); // not configured
  });

  it('the slide-out menu traps focus and navigates in-app', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/' });
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog', { name: 'Site menu' });
    const close = within(dialog).getByRole('button', { name: 'Close menu' });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('link', { name: 'Mint Now!' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.click(within(dialog).getByRole('link', { name: 'The Collection' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'The Collection' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Site menu' })).not.toBeInTheDocument();
  });
});

describe('/ Home', () => {
  it('hero, certified vs projected stats, the comic teaser, latest mints and the CTA', async () => {
    renderApp(fakes(), { path: '/' });
    expect(screen.getByRole('heading', { level: 1, name: 'Decentralized Gentlemen Club' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getAllByRole('link', { name: 'Mint Now' })[0]).toHaveAttribute('href', '/mint');
    expect(within(main).getAllByRole('link', { name: 'Learn How' })[0]).toHaveAttribute('href', '/how-it-works');
    expect(within(main).getByText('certified')).toBeInTheDocument();
    expect(within(main).getByText('projected')).toBeInTheDocument();
    expect(within(main).getByRole('heading', { name: 'This is Gentlemen- The Comic' })).toBeInTheDocument();
    const latest = await screen.findByRole('list', { name: 'Latest Degents' });
    await waitFor(() => expect(within(latest).getAllByRole('link')).toHaveLength(6));
    expect(within(latest).getAllByRole('link')[0]).toHaveAttribute('href', '/collection/4112');
    expect(within(main).getByRole('heading', { name: 'Degen Minter' })).toBeInTheDocument();
    expect(within(main).getByText('Create Bitcoin Ordinals Inscriptions.')).toBeInTheDocument();
  });
});

describe('/collection', () => {
  it('pagination: Showing 1–20 of N, per page, page select, first/prev/next/last, go to', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/collection' });
    const showing = screen.getByTestId('showing');
    await waitFor(() => expect(showing).toHaveTextContent('Showing 1–20 of 4,112'));
    const grid = screen.getByRole('list', { name: 'Degents on this page' });
    expect(within(grid).getAllByRole('listitem')).toHaveLength(20);
    expect(within(grid).getAllByText(/^DEGENT #\d+$/)[0]).toHaveTextContent('DEGENT #1');
    const pageSelect = screen.getByLabelText('Page') as HTMLSelectElement;
    expect(pageSelect.selectedOptions[0]).toHaveTextContent('1 of 206');
    const pager = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(pager).getAllByRole('button', { name: /^Page \d+$/ }).map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '206']);
    await user.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(showing).toHaveTextContent('Showing 21–40 of 4,112'));
    expect(within(pager).getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(pager).getByRole('button', { name: 'Last page' }));
    await waitFor(() => expect(showing).toHaveTextContent('Showing 4,101–4,112 of 4,112'));
    await user.type(screen.getByLabelText('Go to'), '3');
    await user.click(within(pager).getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(showing).toHaveTextContent('Showing 41–60 of 4,112'));
    await user.click(within(pager).getByRole('button', { name: 'First page' }));
    await user.selectOptions(screen.getByLabelText('Per page'), '40');
    await waitFor(() => expect(showing).toHaveTextContent('Showing 1–40 of 4,112'));
    expect((screen.getByLabelText('Page') as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('1 of 103');
  });

  it('filters by number, tier and size (server-side, so the count stays honest)', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/collection' });
    const showing = screen.getByTestId('showing');
    await waitFor(() => expect(showing).toHaveTextContent('of 4,112'));
    await user.selectOptions(screen.getByLabelText('Tier'), 'block');
    await waitFor(() => expect(showing).not.toHaveTextContent('of 4,112'));
    const blocks = Number(showing.textContent!.match(/of ([\d,]+)/)![1]!.replace(/,/g, ''));
    expect(blocks).toBeGreaterThan(0);
    expect(blocks).toBeLessThan(4112);
    await user.selectOptions(screen.getByLabelText('Tier'), '');
    await user.selectOptions(screen.getByLabelText('Size'), '1000+');
    await waitFor(() => expect(showing).not.toHaveTextContent('of 4,112'));
    const huge = Number(showing.textContent!.match(/of ([\d,]+)/)![1]!.replace(/,/g, ''));
    expect(huge).toBeLessThan(blocks);
    await user.selectOptions(screen.getByLabelText('Size'), 'any');
    await user.type(screen.getByLabelText('Number'), '#17');
    await waitFor(() => expect(showing).toHaveTextContent('Showing 1–1 of 1'));
    expect(screen.getByRole('button', { name: 'Open Degent #17' })).toBeInTheDocument();
  });

  it('lightbox: prefetched on-chain details (no loading flash), ordinals.com + Buy links, keyboard operable', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    renderApp(fakes({ log }), { path: '/collection' });
    await waitFor(() => expect(screen.getByTestId('showing')).toHaveTextContent('Showing 1–20'));
    // The whole page is prefetched before anyone opens a Degent.
    await waitFor(() => expect(log.filter((l) => l === 'chain.getInscriptionInfo')).toHaveLength(20));
    const opener = screen.getByRole('button', { name: 'Open Degent #1' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'DEGENT #1' });
    expect(within(dialog).queryByLabelText('fetching from ord')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/LOADING/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText('image/webp')).toBeInTheDocument();
    expect(within(dialog).getByText(/^[\d,]+ sats$/)).toBeInTheDocument(); // fee
    expect(within(dialog).getByText(/UTC$/)).toBeInTheDocument(); // timestamp
    const id = within(dialog).getAllByText(/^[0-9a-f]{64}i0$/)[0]!.textContent!;
    expect(within(dialog).getByRole('link', { name: /View on Ordinals.com/ })).toHaveAttribute('href', `https://ord.test/inscription/${id}`);
    expect(within(dialog).getByRole('link', { name: /Buy Item/ })).toHaveAttribute('href', `https://magiceden.io/ordinals/item-details/${id}`);
    expect(within(dialog).getByRole('link', { name: /Open the page for Degent #1/ })).toHaveAttribute('href', '/collection/1');
    expect(log.filter((l) => l === 'chain.getInscriptionInfo')).toHaveLength(20); // served from the cache
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'DEGENT #2' })).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'DEGENT #20' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('list', { name: 'This page' })).getByRole('button', { name: 'Show Degent #5' }));
    expect(screen.getByRole('dialog', { name: 'DEGENT #5' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('page window: 1 2 3 4 … N at the start, neighbours in the middle', () => {
    expect(pageWindow(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(pageWindow(0, 206)).toEqual([0, 1, 2, 3, '…', 205]);
    expect(pageWindow(100, 206)).toEqual([0, '…', 99, 100, 101, '…', 205]);
    expect(pageWindow(205, 206)).toEqual([0, '…', 202, 203, 204, 205]);
  });
});

describe('/collection/:n', () => {
  it('deep link: h1, details, title, OpenGraph tags and a JSON-LD block', async () => {
    renderApp(fakes(), { path: '/collection/17', app: testApp({ siteUrl: 'https://degent.club' }) });
    expect(screen.getByRole('heading', { level: 1, name: 'Degent #17' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Degent #17' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Degent #17 · degent.club'));
    const og = (p: string) => document.head.querySelector(`meta[property="${p}"]`)?.getAttribute('content');
    expect(og('og:url')).toBe('https://degent.club/collection/17');
    expect(og('og:image')).toMatch(/^data:image\/svg\+xml/);
    expect(document.head.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary_large_image');
    const ld = JSON.parse(document.head.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(ld).toMatchObject({ '@type': 'VisualArtwork', name: 'Degent #17', url: 'https://degent.club/collection/17', isPartOf: { name: 'Decentralized Gentlemen Club' } });
    expect(ld.identifier).toMatch(/^[0-9a-f]{64}i0$/);
    expect(screen.getByRole('link', { name: '‹ Degent #16' })).toHaveAttribute('href', '/collection/16');
  });

  it('says so when the Register has no such Degent yet', async () => {
    renderApp(fakes(), { path: '/collection/9999' });
    expect(await screen.findByText(/No Degent #9999 in the Register yet/)).toBeInTheDocument();
  });
});

describe('/comic', () => {
  it('shows a placeholder until the comic inscription id is configured', () => {
    renderApp(fakes(), { path: '/comic' });
    expect(screen.getByRole('heading', { level: 1, name: 'This is Gentlemen- The Comic' })).toBeInTheDocument();
    expect(screen.getByText(/VITE_COMIC_INSCRIPTION_ID/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('embeds the on-chain comic (sandboxed ord /content) with zoom and full-screen controls', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/comic', app: testApp({ comicInscriptionId: ID1 }) });
    const frame = screen.getByTitle('The Decentralized Gentlemen Club comic, from its inscription');
    expect(frame).toHaveAttribute('src', `https://ord.test/content/${ID1}`);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    const bar = screen.getByRole('toolbar', { name: 'Reader controls' });
    await user.click(within(bar).getByRole('button', { name: 'Zoom in' }));
    expect(within(bar).getByText('125%')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Full screen' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: /View on ordinals.com/ })).toHaveAttribute('href', `https://ord.test/inscription/${ID1}`);
  });

  it('reads page by page with buttons and the arrow keys', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { path: '/comic', app: testApp({ comicPages: [ID1, ID2] }) });
    expect(screen.getByRole('img', { name: 'Comic page 1 of 2' })).toHaveAttribute('src', `https://ord.test/content/${ID1}`);
    await user.click(screen.getByRole('button', { name: 'Next page ›' }));
    expect(screen.getByRole('img', { name: 'Comic page 2 of 2' })).toHaveAttribute('src', `https://ord.test/content/${ID2}`);
    screen.getByLabelText(/use the arrow keys/).focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });
});

describe('/how-it-works', () => {
  it('rules, tiers and live fees (from @bsh/inscription), wallets, the four stages, review, self-rescue and the bundle', async () => {
    renderApp(fakes(), { path: '/how-it-works' });
    expect(screen.getByRole('heading', { level: 1, name: 'Minting Process' })).toBeInTheDocument();
    for (const t of ['File Format & Size', 'Essential Design', 'Framing & Text', 'Quantity']) expect(screen.getByRole('heading', { name: new RegExp(t) })).toBeInTheDocument();
    expect(screen.getByText('Square JPEG format with a minimum size of 200KB.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Did you know?' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Standard Degent' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /Worked examples/ });
    await waitFor(() => expect(within(table).getAllByText(/^[\d,]+ vB$/)).toHaveLength(2));
    expect(screen.getByText('UniSat')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Design → Mint → Confirm → Approve' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /self-rescue/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The recovery bundle' })).toBeInTheDocument();
  });
});

describe('/club', () => {
  it('signs in with Bitcoin (SIWB), lists your Degents from the Register, links to review and the Telegram gate', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    renderApp(fakes({ log }), { path: '/club' });
    await user.click(screen.getByRole('button', { name: 'Sign in to the club with UniSat' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back, gentleman.' })).toBeInTheDocument();
    const yours = await screen.findByRole('list', { name: 'Your Degents' });
    expect(within(yours).getByRole('link', { name: 'Degent #17' })).toHaveAttribute('href', '/collection/17');
    expect(log).toContain('api.getHolder');
    expect(log.indexOf('api.authVerify')).toBeLessThan(log.indexOf('api.getHolder'));
    expect(screen.getByRole('link', { name: 'Open the review' })).toHaveAttribute('href', '/review');
    expect(screen.getByRole('link', { name: 'About /verify' })).toHaveAttribute('href', '/verify');
    expect(screen.getByText(/TODO\(copy\): the member perks/)).toBeInTheDocument();
  });

  it('turns away a wallet with no Degent, kindly', async () => {
    renderApp(fakes({ mint: { holders: {} } }), { path: '/club' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to the club with UniSat' }));
    expect(await screen.findByText('No Degent at this address yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mint one' })).toHaveAttribute('href', '/mint');
  });
});

describe('TODO(copy) pages and not found', () => {
  it.each([
    ['/manifesto', 'Manifesto'],
    ['/about', 'About'],
  ])('%s is a TODO(copy) placeholder, no invented text', (path, title) => {
    renderApp(fakes(), { path });
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`TODO\\(copy\\): the ${title} text`))).toBeInTheDocument();
  });

  it('unknown paths get a not-found page with a way home', () => {
    renderApp(fakes(), { path: '/blog/some-post' });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  });
});
