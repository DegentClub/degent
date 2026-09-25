import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEGENT_RULES } from '@bsh/degent-mint-sdk';
import { fakes, renderApp, testApp } from './helpers';
import { CertifyApiError } from '../src/services/certifyApi';
import { createFakeSite } from '../src/services/fakeSite';
import { demoArtistAddress, DEMO_ARTISTS } from '../src/services/fakes';
import { shortHash } from '../src/lib/format';
import { ruleCards } from '../src/screens/MintProcess';
import { preloadedImages } from '../src/lib/detailsCache';
import { THEME_KEY } from '../src/lib/theme';
import { METERS_AFTER_PX } from '../src/components/SiteHeader';

const liveFailing = () =>
  fakes({ site: { certifyError: new CertifyApiError(0, 'network_error', 'block.space could not be reached') } });

describe('Home (#/)', () => {
  it('#/ is the Home page (not the wizard): hero, CTAs to Mint and Gallery, the collection card from the certificate', async () => {
    renderApp(fakes(), { hash: '#/' });
    expect(screen.getByRole('heading', { level: 1, name: 'Decentralized Gentlemen Club' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start minting' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Mint progress' })).not.toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(within(main).getAllByRole('link', { name: /Mint Now/ })[0]).toHaveAttribute('href', '#/mint');
    expect(within(main).getByRole('link', { name: 'Gallery' })).toHaveAttribute('href', '#/gallery');
    const card = screen.getByTestId('collection-card');
    await waitFor(() => expect(within(card).getByTestId('stat-minted')).toHaveTextContent('4,112'));
    expect(within(card).getByTestId('stat-slug')).toHaveTextContent('degents');
  });

  it('labels projected vs certified explicitly; demo counts are labelled demo data', async () => {
    const services = fakes();
    renderApp(services, { hash: '#/' });
    const card = screen.getByTestId('collection-card');
    await waitFor(() => expect(within(card).getByTestId('stat-minted')).toHaveTextContent('4,112'));
    expect(within(card).getByTestId('stat-supply')).toHaveTextContent('10,000');
    expect(within(card).getByTestId('stat-supply')).toHaveTextContent('projected');
    expect(within(card).getByTestId('stat-supply')).not.toHaveTextContent('certified');
    expect(within(card).getByTestId('stat-minted')).toHaveTextContent('demo data');
    const mb = `${Math.round(services.siteState.response.attestation.stats.totalContentBytes / 1e6).toLocaleString('en-US')} MB`;
    expect(within(card).getByTestId('stat-blockspace')).toHaveTextContent(mb);
    expect(within(card).getByTestId('stat-blockspace')).toHaveTextContent('of 3 GB projected');
    expect(within(card).getByTestId('projection')).toHaveTextContent('Target: 10K = 3+ GB of blockspace projected');
    expect(within(card).getByTestId('certline')).toHaveTextContent('Demo data: a simulated block.space attestation');
    expect(within(card).getByTestId('studio-line')).toHaveTextContent('6 certified mints by 2 artists across 3 artworks · 4 artist royalties verified on chain');
    // No stale hard-coded counts from the old site anywhere.
    expect(document.body).not.toHaveTextContent(/4,027|4027|1470 ?MB|1,470/);
  });

  it('live mode with the certificate unavailable shows no numbers (not guessed) and says why', async () => {
    const services = liveFailing();
    renderApp({ ...services, mode: 'live' }, { hash: '#/', app: testApp({ demo: false }) });
    expect(await screen.findByText('The block.space certificate is unavailable')).toBeInTheDocument();
    const card = screen.getByTestId('collection-card');
    expect(within(card).getByTestId('stat-minted')).toHaveTextContent('Minted: —');
    expect(within(card).getByTestId('stat-blockspace')).toHaveTextContent('Blockspace: —');
    expect(screen.queryByTestId('gauge-minted')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('demo data');
  });

  it('live mode with a certificate says "certified", never "demo data"', async () => {
    const services = fakes();
    renderApp({ ...services, mode: 'live' }, { hash: '#/', app: testApp({ demo: false }) });
    const card = screen.getByTestId('collection-card');
    await waitFor(() => expect(within(card).getByTestId('stat-minted')).toHaveTextContent('4,112certified'));
    expect(within(card).getByTestId('certline')).toHaveTextContent(/^Certified by block\.space at block 915,020/);
    expect(document.body).not.toHaveTextContent('demo data');
  });
});

describe('The Collection (#/collection)', () => {
  it('renders the hero and a grid of 20 gold-framed DEGENT #N tiles from the certificate', async () => {
    renderApp(fakes(), { hash: '#/collection' });
    expect(screen.getByRole('heading', { level: 1, name: 'The Collection' })).toBeInTheDocument();
    expect(await screen.findByText('Showing 1–20 of 4,112')).toBeInTheDocument();
    const grid = screen.getByRole('list', { name: 'Certified Degents' });
    await waitFor(() => expect(within(grid).getByRole('link', { name: /DEGENT #1, inscription/ })).toBeInTheDocument());
    const tiles = within(grid).getAllByRole('listitem');
    expect(tiles).toHaveLength(20);
    expect(tiles[19]).toHaveTextContent('DEGENT #20');
    expect(tiles[0]!.querySelector('.frame')).not.toBeNull();
    expect(within(tiles[0]!).getByRole('img', { name: 'DEGENT #1' }).getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(within(tiles[4]!).getByRole('link')).toHaveAttribute('href', '#/collection/5');
  });

  it('toolbar: next/last/first/prev, numbered pages with gaps, and the page select', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { hash: '#/collection' });
    await screen.findByText('Showing 1–20 of 4,112');
    const nav = screen.getByRole('navigation', { name: 'Collection pages' });
    expect(within(nav).getByLabelText('First page')).toHaveAttribute('aria-disabled', 'true');
    expect(within(nav).getByText('1')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Page 206' })).toBeInTheDocument();
    expect(nav).toHaveTextContent('…');
    await user.click(within(nav).getByRole('link', { name: 'Next page' }));
    expect(window.location.hash).toBe('#/collection?page=2');
    expect(await screen.findByText('Showing 21–40 of 4,112')).toBeInTheDocument();
    await user.click(within(screen.getByRole('navigation', { name: 'Collection pages' })).getByRole('link', { name: 'Last page' }));
    expect(await screen.findByText('Showing 4,101–4,112 of 4,112', {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Certified Degents' })).getAllByRole('listitem')).toHaveLength(12));
    expect(screen.getByRole('link', { name: /DEGENT #4,112|DEGENT #4112/ })).toBeInTheDocument();
    await user.click(within(screen.getByRole('navigation', { name: 'Collection pages' })).getByRole('link', { name: 'Previous page' }));
    expect(await screen.findByText('Showing 4,081–4,100 of 4,112')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Page'), '3');
    expect(await screen.findByText('Showing 41–60 of 4,112')).toBeInTheDocument();
    await user.click(within(screen.getByRole('navigation', { name: 'Collection pages' })).getByRole('link', { name: 'First page' }));
    expect(await screen.findByText('Showing 1–20 of 4,112')).toBeInTheDocument();
  });

  it('per-page selector keeps the first shown member on screen and goes into the URL', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { hash: '#/collection?page=3' });
    await screen.findByText('Showing 41–60 of 4,112');
    await user.selectOptions(screen.getByLabelText('Per page'), '40');
    expect(window.location.hash).toBe('#/collection?page=2&per=40');
    expect(await screen.findByText('Showing 41–80 of 4,112')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Certified Degents' })).getAllByRole('listitem')).toHaveLength(40));
    expect(screen.getByLabelText('Page')).toHaveDisplayValue('2 of 103');
  });

  it('“Go to” jumps to a page and refuses out-of-range input with a message', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { hash: '#/collection' });
    await screen.findByText('Showing 1–20 of 4,112');
    const input = screen.getByLabelText('Go to');
    await user.type(input, '999');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pages are 1–206.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.clear(input);
    await user.type(input, '100{Enter}');
    expect(window.location.hash).toBe('#/collection?page=100');
    expect(await screen.findByText('Showing 1,981–2,000 of 4,112')).toBeInTheDocument();
  });

  it('opens the lightbox from a tile: inscription id, address, content type/length, timestamp, block height, fee, ordinals.com link', async () => {
    const user = userEvent.setup();
    const services = fakes();
    renderApp(services, { hash: '#/collection' });
    const grid = await screen.findByRole('list', { name: 'Certified Degents' });
    await user.click(await within(grid).findByRole('link', { name: /DEGENT #3, inscription/ }));
    expect(window.location.hash).toBe('#/collection/3');
    const dialog = await screen.findByRole('dialog', { name: 'DEGENT #3' });
    const item = services.siteState.items[2]!;
    expect(within(dialog).getByText(item.inscriptionId)).toBeInTheDocument();
    expect(within(dialog).getByText(item.contentType!)).toBeInTheDocument();
    expect(within(dialog).getByText(`${item.contentLength.toLocaleString('en-US')} bytes`)).toBeInTheDocument();
    expect(within(dialog).getByText(item.height.toLocaleString('en-US'))).toBeInTheDocument();
    const ord = await services.ord.getInscription(item.inscriptionId);
    expect(await within(dialog).findByText(ord.address!)).toBeInTheDocument();
    expect(within(dialog).getByText(`${ord.fee!.toLocaleString('en-US')} sats`)).toBeInTheDocument();
    expect(within(dialog).getByText(/UTC$/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /View on Ordinals\.com/ })).toHaveAttribute('href', `https://ordinals.com/inscription/${item.inscriptionId}`);
    expect(within(dialog).getByRole('link', { name: /Buy Item/ })).toHaveAttribute('href', expect.stringContaining(item.inscriptionId));
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('lightbox next/prev/filmstrip/keyboard navigate without adding history entries; Escape closes back to the page', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { hash: '#/collection/21' });
    await screen.findByRole('dialog', { name: 'DEGENT #21' });
    expect(screen.getByText('Showing 21–40 of 4,112')).toBeInTheDocument();
    const depth = window.history.length;
    await user.click(screen.getByRole('button', { name: 'Next Degent' }));
    expect(await screen.findByRole('dialog', { name: 'DEGENT #22' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/collection/22');
    await user.click(screen.getByRole('button', { name: 'Previous Degent' }));
    await screen.findByRole('dialog', { name: 'DEGENT #21' });
    const strip = screen.getByRole('list', { name: 'Nearby Degents' });
    expect(within(strip).getAllByRole('button')).toHaveLength(9);
    expect(within(strip).getByRole('button', { name: 'DEGENT #21' })).toHaveAttribute('aria-current', 'true');
    await user.click(within(strip).getByRole('button', { name: 'DEGENT #25' }));
    await screen.findByRole('dialog', { name: 'DEGENT #25' });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await screen.findByRole('dialog', { name: 'DEGENT #24' });
    expect(window.history.length).toBe(depth);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.hash).toBe('#/collection?page=2');
  });

  it('prefetches the neighbours’ ord details and images, so next shows full details at once (no LOADING flash) and ord is asked once per Degent', async () => {
    const user = userEvent.setup();
    const services = fakes();
    renderApp(services, { hash: '#/collection/10' });
    const items = services.siteState.items;
    await waitFor(() => expect(services.siteState.ordServed).toEqual(expect.arrayContaining([8, 9, 10, 11, 12].map((n) => items[n - 1]!.inscriptionId))));
    expect(preloadedImages().has(services.ord.contentUrl(items[10]!.inscriptionId))).toBe(true);
    // The expected details, from a separate (deterministic) fake so this lookup is not counted.
    const next = await createFakeSite().ord.getInscription(items[10]!.inscriptionId);
    const served = services.siteState.ordServed.length;
    await user.click(screen.getByRole('button', { name: 'Next Degent' }));
    const dialog = screen.getByRole('dialog', { name: 'DEGENT #11' });
    // Synchronously complete: the address is already there, no shimmer, no "loading" text.
    expect(within(dialog).getByText(next.address!)).toBeInTheDocument();
    expect(dialog.querySelector('.shimmer')).toBeNull();
    expect(dialog).not.toHaveTextContent(/loading/i);
    // Moving on only fetches the newly-uncovered neighbour.
    await waitFor(() => expect(services.siteState.ordServed.length - served).toBe(1));
    expect(services.siteState.ordServed.filter((id) => id === items[10]!.inscriptionId)).toHaveLength(1);
  });

  it('an ord outage leaves the certified facts and drops only the ord-only rows', async () => {
    const services = fakes({ site: { ordFails: true } });
    renderApp(services, { hash: '#/collection/2' });
    const dialog = await screen.findByRole('dialog', { name: 'DEGENT #2' });
    expect(await within(dialog).findByText('ord did not answer; showing what block.space certifies.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Address')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Fee')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Block height')).toBeInTheDocument();
  });

  it('an attributed Studio mint links to its artist page and shows the verified royalty', async () => {
    const services = fakes();
    renderApp(services, { hash: '#/collection/4107' });
    const dialog = await screen.findByRole('dialog', { name: 'DEGENT #4,107' }, { timeout: 5000 });
    const ada = demoArtistAddress('ada', 'mainnet');
    expect(await within(dialog).findByRole('link', { name: shortHash(ada, 6) }, { timeout: 5000 })).toHaveAttribute('href', `#/artists/${ada}`);
    expect(within(dialog).getByRole('link', { name: 'art_demo_chairman' })).toHaveAttribute('href', '#/gallery/art_demo_chairman');
    expect(within(dialog).getByText('Artist royalty')).toBeInTheDocument();
    expect(within(dialog).getByText('9,800 sats')).toBeInTheDocument();
  });

  it('a deep link past the end says so', async () => {
    renderApp(fakes(), { hash: '#/collection/9999' });
    expect(await screen.findByText('There is no DEGENT #9,999')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Mint Process (#/mint-process)', () => {
  it('four check-marked cards built from DEGENT_RULES (format + square merged), and the "Did you know?" callout', async () => {
    renderApp(fakes(), { hash: '#/mint-process' });
    expect(screen.getByRole('heading', { level: 1, name: 'Minting Rules' })).toBeInTheDocument();
    expect(screen.getByText('The essential requirements for minting a Degent and joining the club.')).toBeInTheDocument();
    const cards = within(screen.getByRole('list', { name: 'Minting rules' })).getAllByRole('listitem');
    expect(cards).toHaveLength(4);
    const byId = Object.fromEntries(DEGENT_RULES.map((r) => [r.id, r]));
    expect(cards[0]).toHaveTextContent(byId.format!.title);
    expect(cards[0]).toHaveTextContent(byId.format!.text);
    expect(cards[0]).toHaveTextContent(byId.square!.text);
    expect(cards.map((c) => within(c).getByRole('heading', { level: 2 }).textContent)).toEqual(['format', 'design', 'framing', 'quantity'].map((id) => byId[id]!.title));
    for (const c of cards) expect(c.querySelector('.rulecard__check svg')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Did you know?' })).toBeInTheDocument();
    expect(screen.getByText(/All approved Degents become part of the official Decentralized Gentlemen Club collection/)).toBeInTheDocument();
    expect(ruleCards().map((r) => r.id)).toEqual(['format', 'design', 'framing', 'quantity']);
  });
});

describe('Comic, About, Manifesto', () => {
  it('the comic keeps the captured copy and marks the missing inscription as TODO(copy)', async () => {
    renderApp(fakes(), { hash: '#/comic' });
    expect(screen.getByRole('heading', { level: 1, name: 'This is Gentlemen- The Comic' })).toBeInTheDocument();
    expect(screen.getAllByText('TODO(copy)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('View in Ordiscan')).toHaveAttribute('aria-disabled', 'true');
  });

  it('with VITE_COMIC_INSCRIPTION_ID the comic links out to Ordiscan and ordinals.com', async () => {
    const id = `${'ef'.repeat(32)}i0`;
    renderApp(fakes(), { hash: '#/comic', app: testApp({ comicInscriptionId: id }) });
    expect(screen.getByRole('link', { name: /View in Ordiscan/ })).toHaveAttribute('href', `https://ordiscan.com/inscription/${id}`);
    expect(screen.getByRole('link', { name: shortHash(id, 8) })).toHaveAttribute('href', `https://ordinals.com/inscription/${id}`);
  });

  it.each([
    ['#/about', 'About'],
    ['#/manifesto', 'Manifesto'],
  ])('%s is a clearly marked placeholder, never invented copy', async (hash, title) => {
    renderApp(fakes(), { hash });
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    const note = screen.getByText('TODO(copy)').closest('.todo-copy')!;
    expect(note).toHaveTextContent('Placeholder page.');
    expect(note).toHaveTextContent('was not captured');
  });
});

describe('Artist page (#/artists/:address)', () => {
  it('joins the studio profile, the certified members (artists endpoint) and the approved Studio artworks', async () => {
    const services = fakes();
    const ada = demoArtistAddress('ada', 'mainnet');
    renderApp(services, { hash: `#/artists/${ada}` });
    expect(await screen.findByRole('heading', { level: 1, name: DEMO_ARTISTS.ada.displayName })).toBeInTheDocument();
    expect(screen.getByText(ada)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('artist-certified')).toHaveTextContent('4'));
    const certified = screen.getByRole('list', { name: 'Certified Degents by this artist' });
    const items = within(certified).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(certified).toHaveTextContent('The Chairman');
    expect(certified).toHaveTextContent('edition 3');
    expect(certified).toHaveTextContent('royalty 9,800 sats verified');
    expect(screen.getByText('Royalties verified on chain')).toBeInTheDocument();
    const hanging = await screen.findByRole('list', { name: 'Studio artworks by this artist' });
    expect(within(hanging).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('artist-hanging')).toHaveTextContent('2');
    expect(services.log).toEqual(expect.arrayContaining(['studio.getArtist', 'certify.listArtistItems', 'studio.listArtworks']));
  });

  it('an address with no profile and no certified member still renders, saying so', async () => {
    const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    renderApp(fakes(), { hash: `#/artists/${addr}` });
    expect(await screen.findByText('No certified Degent is attributed to this address yet.')).toBeInTheDocument();
    expect(await screen.findByText(/no public studio profile/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(shortHash(addr, 8));
    expect(await screen.findByText('Nothing of theirs hangs in the gallery right now.')).toBeInTheDocument();
  });

  it('the artwork page links to the artist page', async () => {
    renderApp(fakes(), { hash: '#/gallery/art_demo_chairman' });
    expect(await screen.findByRole('link', { name: 'Artist page' })).toHaveAttribute('href', `#/artists/${demoArtistAddress('ada', 'mainnet')}`);
  });
});

describe('Global chrome', () => {
  it('header: wordmark, Mint (→ #/mint) and Buy (Magic Eden), and the two live meters from the attestation, shown once scrolled', async () => {
    renderApp(fakes(), { hash: '#/' });
    const header = screen.getByTestId('site-header');
    expect(within(header).getByRole('link', { name: 'degent.club home' })).toHaveTextContent('degent.club');
    expect(header.querySelector('.wordmark__tld')).toHaveTextContent('.club');
    expect(within(header).getByRole('link', { name: /^Mint$/ })).toHaveAttribute('href', '#/mint');
    expect(within(header).getByRole('link', { name: /Buy/ })).toHaveAttribute('href', 'https://magiceden.io/ordinals/marketplace/degentclub');
    const minted = await within(header).findByTestId('gauge-minted');
    expect(minted).toHaveTextContent('Minted 4,112 demo / 10,000 projected');
    expect(within(header).getByTestId('gauge-inscribed')).toHaveTextContent(/Inscribed [\d,]+ MB demo \/ 3 GB projected/);
    expect(within(minted).getByRole('meter')).toHaveAttribute('aria-valuetext', '4,112 certified of 10,000 projected (41.12%)');
    const meters = header.querySelector('.site-header__meters')!;
    expect(meters).toHaveAttribute('data-shown', 'false');
    act(() => {
      Object.defineProperty(window, 'scrollY', { value: METERS_AFTER_PX + 50, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => expect(meters).toHaveAttribute('data-shown', 'true'));
    expect(header).toHaveClass('is-scrolled');
    act(() => {
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      window.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => expect(meters).toHaveAttribute('data-shown', 'false'));
  });

  it('hamburger opens the slide-out nav (Home · About · The Collection · Gallery · Mint Process · Manifesto · Blog · Studio + Mint Now!), Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { hash: '#/about' });
    expect(screen.queryByRole('navigation', { name: 'Site' })).not.toBeInTheDocument();
    const burger = screen.getByRole('button', { name: 'Menu' });
    expect(burger).toHaveAttribute('aria-expanded', 'false');
    await user.click(burger);
    expect(burger).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: 'Site' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'About', 'The Collection', 'Gallery', 'Mint Process', 'Manifesto', 'Blog', 'Studio']);
    expect(within(nav).getByRole('link', { name: 'About' })).toHaveAttribute('aria-current', 'page');
    const panel = screen.getByRole('dialog', { name: 'degent.club' });
    expect(within(panel).getByRole('link', { name: /Mint Now!/ })).toHaveAttribute('href', '#/mint');
    expect(within(panel).getAllByRole('button', { name: 'Close menu' })[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('navigation', { name: 'Site' })).not.toBeInTheDocument();
    expect(burger).toHaveFocus();
  });

  it('a nav link navigates and closes the panel', async () => {
    const user = userEvent.setup();
    renderApp(fakes(), { hash: '#/' });
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(within(screen.getByRole('navigation', { name: 'Site' })).getByRole('link', { name: 'Mint Process' }));
    expect(window.location.hash).toBe('#/mint-process');
    expect(await screen.findByRole('heading', { level: 1, name: 'Minting Rules' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Site' })).not.toBeInTheDocument();
  });

  it('light theme toggle persists the viewer’s choice and sets data-theme', async () => {
    const user = userEvent.setup();
    const { store } = renderApp(fakes(), { hash: '#/' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    const toggle = screen.getByRole('button', { name: 'Light theme' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(store.getItem(THEME_KEY)).toBe('light');
    await user.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('social rail (X, Telegram; Instagram marked TODO), back to top, footer tagline and quick links', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    renderApp(fakes(), { hash: '#/' });
    const rail = screen.getByRole('complementary', { name: 'degent.club elsewhere' });
    expect(within(rail).getByRole('link', { name: /X \/ Twitter/ })).toHaveAttribute('href', 'https://x.com/degentclub');
    expect(within(rail).getByRole('link', { name: /Telegram/ })).toHaveAttribute('href', 'https://t.me/+cneroYQ-0VpmM2Ix');
    expect(within(rail).getByRole('img', { name: /Instagram: link not available yet/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to top', hidden: true }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('A community-driven 10K ordinal collection of unique Pepes in tuxedos, built on Bitcoin.');
    const links = within(within(footer).getByRole('navigation', { name: 'Quick links' })).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(expect.arrayContaining(['Home', 'About', 'Minting Process', 'The Collection', 'Blog']));
  });

  it('newsletter posts nowhere: it validates the address and says "coming soon", never that you subscribed', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderApp(fakes(), { hash: '#/' });
    const footer = screen.getByRole('contentinfo');
    await user.type(within(footer).getByLabelText('E-mail'), 'not-an-email');
    await user.click(within(footer).getByRole('button', { name: 'Subscribe' }));
    expect(within(footer).getByRole('status')).toHaveTextContent('That e-mail address does not look right.');
    await user.type(within(footer).getByLabelText('Name'), 'Pepe');
    await user.clear(within(footer).getByLabelText('E-mail'));
    await user.type(within(footer).getByLabelText('E-mail'), 'pepe@degent.club');
    await user.click(within(footer).getByRole('button', { name: 'Subscribe' }));
    const msg = within(footer).getByRole('status');
    expect(msg).toHaveTextContent('Newsletter sign-up is coming soon. Nothing was sent and you are not subscribed yet');
    expect(msg).not.toHaveTextContent(/thanks for subscribing|you are subscribed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
