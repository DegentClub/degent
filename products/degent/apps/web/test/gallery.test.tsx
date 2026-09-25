import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEGENT_RULES } from '@bsh/degent-mint-sdk';
import { fakes, renderApp, testApp } from './helpers';
import { demoArtistAddress, DEMO_ARTISTS, DEMO_ARTWORKS } from '../src/services/fakes';
import { shortHash } from '../src/lib/format';

describe('Gallery (#/gallery)', () => {
  it('renders the approved artworks in gold frames with a DEGENT plaque and the artist’s short address, featured first', async () => {
    const services = fakes();
    renderApp(services, { hash: '#/gallery' });
    expect(await screen.findByRole('heading', { level: 1, name: /hung by their makers/ })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Gallery' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(list).getAllByText('DEGENT')).toHaveLength(3);
    // Featured first, then newest.
    expect(items[0]).toHaveTextContent('The Chairman');
    expect(items[0]).toHaveTextContent('Featured');
    expect(items[0]).toHaveTextContent(shortHash(demoArtistAddress('ada', 'mainnet'), 6));
    expect(items[1]).toHaveTextContent('Regen at Dawn');
    expect(items[2]).toHaveTextContent('Martini Hour');
    for (const item of items) {
      const img = within(item).getByRole('img');
      expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
      expect(item.querySelector('.frame')).not.toBeNull();
    }
    expect(screen.getByText('Showing 1–3 of 3')).toBeInTheDocument();
    // The site navigation lives in the slide-out menu (site spec): open it, the Gallery entry is current.
    await userEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('navigation', { name: 'Site' }).querySelector('a[aria-current="page"]')).toHaveTextContent('Gallery');
    expect(services.log.filter((l) => l === 'studio.listArtworks')).toHaveLength(1);
  });

  it('pages through the gallery with the configured page size', async () => {
    const services = fakes();
    renderApp(services, { hash: '#/gallery', app: testApp({ galleryPageSize: 2 }) });
    expect(await screen.findByText('Showing 1–2 of 3')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Gallery' })).getAllByRole('listitem')).toHaveLength(2);
    const pager = screen.getByRole('navigation', { name: 'Gallery pages' });
    expect(within(pager).getByText('1')).toHaveAttribute('aria-current', 'page');
    await userEvent.click(within(pager).getByRole('link', { name: 'Next' }));
    expect(window.location.hash).toBe('#/gallery?page=2');
    expect(await screen.findByText('Showing 3–3 of 3')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Gallery' })).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Gallery pages' })).getByRole('link', { name: 'Page 1' }));
    expect(await screen.findByText('Showing 1–2 of 3')).toBeInTheDocument();
  });

  it('filters by artist from the artist link', async () => {
    const ada = demoArtistAddress('ada', 'mainnet');
    renderApp(fakes(), { hash: `#/gallery?artist=${ada}` });
    expect(await screen.findByText('Showing 1–2 of 2')).toBeInTheDocument();
    expect(screen.getByText(/Showing the work of/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'All artists' }));
    expect(await screen.findByText('Showing 1–3 of 3')).toBeInTheDocument();
  });

  it('an artwork at its edition cap shows a sold-out badge and the ?available filter (ADR-0012)', async () => {
    const services = fakes();
    const regen = DEMO_ARTWORKS[2]!; // maxEditions: 25
    for (let i = 0; i < 25; i++) {
      services.studio.hooks.recordRoyalty({ orderId: `ord_${i}`, artworkId: regen.id, minterAddress: null, royaltySats: 1000, fundingTxid: `${i}`.repeat(64).slice(0, 64), vout: 1, at: new Date().toISOString() });
    }
    renderApp(services, { hash: '#/gallery' });
    const list = await screen.findByRole('list', { name: 'Gallery' });
    const item = within(list).getByText('Regen at Dawn').closest('li')!;
    expect(within(item).getByText('Sold out')).toBeInTheDocument();

    // ?available=1: only mintable pieces (excludes the sold-out one).
    await userEvent.click(screen.getByRole('link', { name: 'Available to mint' }));
    expect(window.location.hash).toBe('#/gallery?available=1');
    await screen.findByText('Showing 1–2 of 2');
    expect(screen.queryByText('Regen at Dawn')).not.toBeInTheDocument();

    // ?available=0: only sold-out pieces.
    await userEvent.click(screen.getByRole('link', { name: 'Sold out' }));
    expect(window.location.hash).toBe('#/gallery?available=0');
    await screen.findByText('Showing 1–1 of 1');
    expect(screen.getByText('Regen at Dawn')).toBeInTheDocument();

    // Back to all.
    await userEvent.click(screen.getByRole('link', { name: 'All' }));
    expect(window.location.hash).toBe('#/gallery');
    await screen.findByText('Showing 1–3 of 3');
  });
});

describe('Artwork page (#/gallery/:id)', () => {
  it('shows the image, title, artist link, the five Degent rules and the edition count when the API supplies it', async () => {
    const services = fakes();
    const chairman = DEMO_ARTWORKS[0]!;
    renderApp(services, { hash: `#/gallery/${chairman.id}` });
    expect(await screen.findByRole('heading', { level: 1, name: 'The Chairman' })).toBeInTheDocument();
    expect(screen.getByText(chairman.description)).toBeInTheDocument();
    const img = screen.getByRole('img', { name: /The Chairman, by/ });
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    const artistLink = await screen.findByTestId('artist-link');
    expect(artistLink).toHaveTextContent(DEMO_ARTISTS.ada.displayName);
    expect(artistLink).toHaveTextContent(shortHash(demoArtistAddress('ada', 'mainnet'), 6));
    expect(artistLink).toHaveAttribute('href', `#/gallery?artist=${demoArtistAddress('ada', 'mainnet')}`);
    const pills = within(screen.getByRole('list', { name: 'Degent rules' })).getAllByRole('listitem');
    expect(pills).toHaveLength(5);
    DEGENT_RULES.forEach((r, i) => expect(pills[i]).toHaveTextContent(r.title));
    expect(screen.getByTestId('editions')).toHaveTextContent('Not minted yet');
    const art = services.studioState.artworks.get(chairman.id)!;
    expect(screen.getByText(art.contentSha256!)).toBeInTheDocument();
    expect(screen.getByText('Standard Degent')).toBeInTheDocument();
  });

  it('counts editions from the studio’s royalty ledger', async () => {
    const services = fakes();
    const id = DEMO_ARTWORKS[1]!.id;
    services.studio.hooks.recordRoyalty({ orderId: 'ord_1', artworkId: id, minterAddress: null, royaltySats: 5000, fundingTxid: 'ab'.repeat(32), vout: 1, at: new Date().toISOString() });
    services.studio.hooks.recordRoyalty({ orderId: 'ord_2', artworkId: id, minterAddress: null, royaltySats: 5000, fundingTxid: 'cd'.repeat(32), vout: 1, at: new Date().toISOString() });
    renderApp(services, { hash: `#/gallery/${id}` });
    expect(await screen.findByTestId('editions')).toHaveTextContent('2 minted · open edition');
  });

  it('“Mint this Degent” enters the wizard with the artwork prefilled', async () => {
    const services = fakes();
    const id = DEMO_ARTWORKS[0]!.id;
    renderApp(services, { hash: `#/gallery/${id}` });
    await userEvent.click(await screen.findByRole('button', { name: 'Mint this Degent' }));
    expect(window.location.hash).toBe(`#/mint/${id}`);
    expect(await screen.findByRole('heading', { level: 1, name: /Mint a Degent/ })).toBeInTheDocument();
    expect(screen.getByTestId('selected-artwork')).toHaveTextContent('You are minting The Chairman');
    expect(screen.getByRole('button', { name: 'Start minting' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Mint progress' })).toBeInTheDocument();
  });

  it('a shared #/mint/:artworkId link loads the artwork into the wizard', async () => {
    renderApp(fakes(), { hash: `#/mint/${DEMO_ARTWORKS[2]!.id}` });
    expect(await screen.findByTestId('selected-artwork')).toHaveTextContent('Regen at Dawn');
  });

  it('a sold-out edition disables Mint and explains why (ADR-0012)', async () => {
    const services = fakes();
    const regen = DEMO_ARTWORKS[2]!; // maxEditions: 25
    for (let i = 0; i < 25; i++) {
      services.studio.hooks.recordRoyalty({ orderId: `ord_${i}`, artworkId: regen.id, minterAddress: null, royaltySats: 1000, fundingTxid: `${i}`.repeat(64).slice(0, 64), vout: 1, at: new Date().toISOString() });
    }
    renderApp(services, { hash: `#/gallery/${regen.id}` });
    expect(await screen.findByRole('heading', { level: 1, name: /Regen at Dawn/ })).toBeInTheDocument();
    expect(screen.getByText('Sold out')).toBeInTheDocument();
    expect(screen.getByTestId('editions')).toHaveTextContent('25 minted of 25 · sold out');
    const mint = screen.getByRole('button', { name: 'Mint this Degent' });
    expect(mint).toBeDisabled();
    expect(screen.getByText(/This edition is sold out: 25 of 25 minted/)).toBeInTheDocument();
  });

  it('says so when the artwork does not exist, and 404s unknown routes', async () => {
    const first = renderApp(fakes(), { hash: '#/gallery/art_nope' });
    expect(await screen.findByText('This Degent could not be found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mint this Degent' })).not.toBeInTheDocument();
    first.unmount();
    renderApp(fakes(), { hash: '#/nowhere/at/all' });
    expect(await screen.findByRole('heading', { level: 1, name: /No such room/ })).toBeInTheDocument();
  });
});
