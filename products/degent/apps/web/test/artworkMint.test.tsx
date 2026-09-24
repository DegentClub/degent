import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flowReducer } from '../src/flow/reducer';
import { initialState } from '../src/flow/state';
import { fakes, renderApp, stateAtQuoteForArtwork, testApp } from './helpers';
import { DEMO_ARTWORKS, demoArtistPayout } from '../src/services/fakes';
import { formatSats } from '../src/lib/format';
import { shortHash } from '../src/lib/format';
import { loadRecovery } from '../src/lib/recovery';

const CHAIRMAN = DEMO_ARTWORKS[0]!.id;

describe('Minting a studio Degent (gallery → wizard)', () => {
  it('Create skips the upload/compress tools and shows the artwork instead', async () => {
    const services = fakes();
    const config = await services.mintApi.getConfig();
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    let s = flowReducer(initialState(), { type: 'CONFIG_LOADED', config });
    s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
    s = flowReducer(s, { type: 'STUDIO_ARTWORK_SELECTED', artwork: await services.studio.getArtwork(CHAIRMAN) });
    s = { ...s, step: 'create' };
    renderApp(services, { initial: s, hash: '#/mint' });
    expect(await screen.findByRole('heading', { level: 1, name: /Mint this Degent/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Upload artwork')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Tier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const cont = screen.getByRole('button', { name: 'Continue to Validate' });
    await waitFor(() => expect(cont).toBeEnabled());
    expect(screen.getByText('Standard Degent')).toBeInTheDocument();
    const art = services.studioState.artworks.get(CHAIRMAN)!;
    expect(screen.getByText(art.contentSha256!)).toBeInTheDocument();
    expect(screen.getByTestId('artwork-lane')).toHaveTextContent(/WU\s+standard lane/);
    expect(services.log).toContain('studio.getContent');
    // Opting out returns the upload tools.
    await userEvent.click(screen.getByRole('button', { name: 'mint your own art instead' }));
    expect(await screen.findByRole('heading', { level: 1, name: /Dress the gentleman/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Upload artwork')).toBeInTheDocument();
  });

  it('Quote renders four lines: network cost, club fee, artist royalty (with the artist address), total', async () => {
    const services = fakes();
    const app = testApp();
    const { state, vault } = await stateAtQuoteForArtwork(services, app, CHAIRMAN);
    const q = state.order!.quote!;
    expect(services.log).not.toContain('api.uploadContent');
    renderApp(services, { initial: state, vault, app, hash: '#/mint' });
    await screen.findByRole('heading', { level: 1, name: /The bill, itemised/ });
    const rows = within(screen.getByTestId('bill')).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Network cost');
    expect(screen.getByTestId('network-cost')).toHaveTextContent(formatSats(q.commitValueSats));
    expect(screen.getByTestId('club-fee')).toHaveTextContent(formatSats(45_000));
    expect(screen.getByTestId('artist-royalty')).toHaveTextContent(formatSats(5_000));
    expect(screen.getByTestId('artist-address')).toHaveTextContent(shortHash(demoArtistPayout('ada', 'mainnet'), 6));
    expect(screen.getByText(/for “The Chairman”/)).toBeInTheDocument();
    expect(screen.getByTestId('total')).toHaveTextContent(formatSats(q.commitValueSats + 45_000 + 5_000));
    expect(q.totalSats).toBe(q.commitValueSats + 45_000 + 5_000);
    expect(screen.queryByText('Reveal transaction')).not.toBeInTheDocument();
    expect(await screen.findByText('✓ Verified: matches service')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Pay' })).toBeEnabled();
  });

  it('pays the artist as output [1], keeps artworkId + edition in the bundle, and Track says “Artist paid” with txid:vout', async () => {
    const user = userEvent.setup();
    const services = fakes();
    const app = testApp();
    const { state, vault } = await stateAtQuoteForArtwork(services, app, CHAIRMAN);
    const { store } = renderApp(services, { initial: state, vault, app, hash: '#/mint' });
    await screen.findByText('✓ Verified: matches service');
    await user.click(screen.getByRole('button', { name: 'Continue to Pay' }));
    await screen.findByRole('heading', { level: 1, name: /Settle the account/ });
    await user.click(screen.getByRole('button', { name: 'Prepare payment' }));
    const bundleText = (await screen.findByLabelText('Recovery bundle (JSON)')) as HTMLTextAreaElement;
    const bundle = JSON.parse(bundleText.value);
    expect(bundle.artworkId).toBe(CHAIRMAN);
    expect(bundle.edition).toBe(1);
    expect(loadRecovery(store)).toMatchObject({ artworkId: CHAIRMAN, edition: 1 });
    const pays = screen.getByText('Pays').parentElement!;
    const lines = within(pays).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(lines[0]).toMatch(/^Commit/);
    expect(lines[1]).toMatch(/^Artist royalty/);
    expect(lines[1]).toContain(formatSats(5_000));
    expect(lines[1]).toContain(shortHash(demoArtistPayout('ada', 'mainnet'), 8));
    expect(lines[2]).toMatch(/^Club fee/);
    expect(lines[3]).toMatch(/^Change/);
    expect(screen.getByText(/the artist’s royalty and the club fee/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /I have kept a copy/ }));
    await user.click(screen.getByRole('button', { name: 'Sign & broadcast with UniSat' }));

    await screen.findByRole('heading', { level: 1, name: /From mempool to membership/ });
    const paid = await screen.findByTestId('artist-paid', {}, { timeout: 4000 });
    expect(paid).toHaveTextContent('Artist paid');
    expect(paid).toHaveTextContent(formatSats(5_000));
    const txid = bundle.commitTxid as string;
    expect(within(paid).getByRole('link')).toHaveAttribute('href', `https://explore.block.space/tx/${txid}`);
    expect(within(paid).getByRole('link')).toHaveTextContent(`${shortHash(txid, 6)}:1`);
    expect(screen.getByTestId('studio-order')).toHaveTextContent(`Studio Degent ${CHAIRMAN} · edition #1`);
    expect(await screen.findByText('hash match ✓', {}, { timeout: 4000 })).toBeInTheDocument();
    // The studio's ledger got the record from the mint.
    expect(services.studioState.royalties).toHaveLength(1);
    expect(services.studioState.royalties[0]).toMatchObject({ artworkId: CHAIRMAN, royaltySats: 5_000, fundingTxid: txid, vout: 1 });
  });
});
