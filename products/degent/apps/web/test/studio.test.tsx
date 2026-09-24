import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiSignIn, fakes, memoryStore, renderApp, testApp } from './helpers';
import { demoArtworkBytes, fakeMessageSignature } from '../src/services/fakes';
import { StudioApiError } from '../src/services/studioApi';
import { payoutMessage, STUDIO_SESSION_KEY } from '../src/lib/studioSession';
import { formatSats, shortHash } from '../src/lib/format';

async function signedInStudio(opts: Parameters<typeof fakes>[0] = {}) {
  const services = fakes(opts);
  const sessionStore = memoryStore();
  const r = renderApp(services, { hash: '#/studio', sessionStore });
  await userEvent.click(await screen.findByRole('button', { name: 'Connect UniSat' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Bitcoin' }));
  await screen.findByRole('heading', { name: 'Your profile' });
  return { ...r, services };
}

describe('Artist Studio: Sign in with Bitcoin', () => {
  it('challenge → wallet signMessage (bip322-simple) → verify, then keeps the session in memory and sessionStorage', async () => {
    const { services, sessionStore } = await signedInStudio();
    const at = (n: string) => services.log.indexOf(n);
    expect(at('studio.challenge')).toBeGreaterThanOrEqual(0);
    expect(at('wallet.signMessage')).toBeGreaterThan(at('studio.challenge'));
    expect(at('studio.verify')).toBeGreaterThan(at('wallet.signMessage'));
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    expect(screen.getByText(`Signed in as ${shortHash(wallet.ordinals.address, 8)}`)).toBeInTheDocument();
    const stored = JSON.parse(sessionStore.getItem(STUDIO_SESSION_KEY)!);
    expect(stored.address).toBe(wallet.ordinals.address);
    expect(services.studioState.sessions.has(stored.token)).toBe(true);
    expect(services.studioState.artists.has(wallet.ordinals.address)).toBe(true);
    // The token never leaks into the call log.
    expect(services.log.join(' ')).not.toContain(stored.token);
  });

  it('restores the session after a reload (GET /artists/me) and sign-out forgets it', async () => {
    const { services, sessionStore, unmount } = await signedInStudio();
    unmount();
    services.log.length = 0;
    renderApp(services, { hash: '#/studio', sessionStore });
    expect(await screen.findByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    expect(services.log).toContain('studio.getMe');
    expect(screen.queryByRole('button', { name: 'Sign in with Bitcoin' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(sessionStore.getItem(STUDIO_SESSION_KEY)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your profile' })).not.toBeInTheDocument();
  });

  it('a stale stored session is dropped, not trusted', async () => {
    const services = fakes();
    const sessionStore = memoryStore();
    sessionStore.setItem(STUDIO_SESSION_KEY, JSON.stringify({ token: 'sess_bogus', address: 'bc1pxyz', expiresAt: new Date(Date.now() + 60_000).toISOString(), method: 'bip322-simple' }));
    renderApp(services, { hash: '#/studio', sessionStore });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect UniSat' }));
    expect(await screen.findByRole('button', { name: 'Sign in with Bitcoin' })).toBeEnabled();
    expect(sessionStore.getItem(STUDIO_SESSION_KEY)).toBeNull();
  });

  it('saves the display name', async () => {
    const { services } = await signedInStudio();
    await userEvent.type(screen.getByLabelText('Display name'), 'Ada Croak');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    await waitFor(() => expect(services.studioState.artists.get(wallet.ordinals.address)!.displayName).toBe('Ada Croak'));
  });
});

describe('Artist Studio: payout address proof (BIP-322)', () => {
  it('signs the fixed message with the ordinals (taproot) address and stores the proven address', async () => {
    const { services } = await signedInStudio();
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    expect(screen.getByText('No payout address yet')).toBeInTheDocument();
    expect(screen.getByText(payoutMessage(wallet.ordinals.address, wallet.ordinals.address))).toBeInTheDocument();
    const before = services.log.filter((l) => l === 'wallet.signMessage').length;
    await userEvent.click(screen.getByRole('button', { name: 'Prove & save payout address' }));
    const proven = await screen.findByText('✓ Proven');
    expect(proven.closest('p')).toHaveTextContent(`Royalties go to ${wallet.ordinals.address}`);
    expect(services.log.filter((l) => l === 'wallet.signMessage')).toHaveLength(before + 1);
    expect(services.studioState.artists.get(wallet.ordinals.address)!.payoutAddress).toBe(wallet.ordinals.address);
  });

  it('accepts the Native SegWit payment address too', async () => {
    const { services } = await signedInStudio();
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    const group = screen.getByRole('radiogroup', { name: 'Payout address' });
    await userEvent.click(within(group).getByRole('radio', { name: /Payment address/ }));
    expect(screen.getByText(payoutMessage(wallet.payment.address, wallet.ordinals.address))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Prove & save payout address' }));
    expect(await screen.findByText('✓ Proven')).toBeInTheDocument();
    expect(services.studioState.artists.get(wallet.ordinals.address)!.payoutAddress).toBe(wallet.payment.address);
  });

  it('refuses a legacy payment address before asking the wallet, and explains why', async () => {
    const { services } = await signedInStudio({ wallet: { paymentType: 'p2pkh' } });
    const group = screen.getByRole('radiogroup', { name: 'Payout address' });
    const payment = within(group).getByRole('radio', { name: /Payment address/ });
    expect(within(group).getByText('Legacy')).toBeInTheDocument();
    const before = services.log.filter((l) => l === 'wallet.signMessage').length;
    await userEvent.click(payment);
    expect(await screen.findByText('Legacy address: the studio refuses it')).toBeInTheDocument();
    expect(screen.getByText(/only pays royalties to Native SegWit \(bc1q…\) or Taproot \(bc1p…\) addresses/)).toBeInTheDocument();
    expect(screen.getByText(/BIP-322 proof/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prove & save payout address' })).toBeDisabled();
    expect(services.log.filter((l) => l === 'wallet.signMessage')).toHaveLength(before);
  });

  it('the studio API itself refuses legacy addresses (payout_address_legacy) and bad proofs (payout_proof_invalid)', async () => {
    const services = fakes();
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    const { token, address } = await apiSignIn(services, wallet);
    const legacy = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
    await expect(services.studio.updateMe(token, { payout: { address: legacy, signature: fakeMessageSignature(legacy, payoutMessage(legacy, address)) } })).rejects.toMatchObject({
      code: 'payout_address_legacy',
    });
    const other = wallet.payment.address;
    // A proof made for another session subject does not verify.
    await expect(services.studio.updateMe(token, { payout: { address: other, signature: fakeMessageSignature(other, payoutMessage(other, 'bc1psomeoneelse')) } })).rejects.toBeInstanceOf(StudioApiError);
    await expect(services.studio.updateMe(token, { payout: { address: other, signature: 'nope' } })).rejects.toMatchObject({ code: 'payout_proof_invalid' });
  });
});

function pngFile(seed: number, name = 'gent.png'): File {
  return new File([demoArtworkBytes(seed).slice()], name, { type: 'image/png' });
}

async function uploadPiece(title: string, file: File) {
  await userEvent.click(screen.getByRole('link', { name: 'Hang a new Degent' }));
  await screen.findByRole('heading', { level: 1, name: /Hang a Degent/ });
  await userEvent.type(screen.getByLabelText(/^Title/), title);
  await userEvent.upload(screen.getByLabelText('Artwork file'), file);
  const list = await screen.findByRole('list', { name: 'Local checks' });
  return { list };
}

describe('Artist Studio: upload flow (declare → PUT content → verdict)', () => {
  it('approved: declares, uploads the exact bytes once, and the piece hangs', async () => {
    const { services } = await signedInStudio();
    await uploadPiece('First Gentleman', pngFile(7));
    expect(screen.getAllByText(/: passed/)).toHaveLength(3);
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
    const verdict = await screen.findByTestId('verdict');
    expect(verdict).toHaveTextContent('Hanging');
    expect(within(verdict).getByRole('link', { name: 'See it' })).toBeInTheDocument();
    const at = (n: string) => services.log.indexOf(n);
    expect(at('studio.createArtwork')).toBeGreaterThanOrEqual(0);
    expect(at('studio.uploadContent')).toBeGreaterThan(at('studio.createArtwork'));
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    const mine = [...services.studioState.artworks.values()].filter((w) => w.artist === wallet.ordinals.address);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe('approved');
    expect(mine[0]!.title).toBe('First Gentleman');
    expect(mine[0]!.contentLength).toBe(demoArtworkBytes(7).length);
  });

  it('rejected: shows the verdict with the reasons', async () => {
    await signedInStudio({ studio: { reviewScenario: 'reject' } });
    await uploadPiece('No Bowtie', pngFile(8));
    await userEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    const verdict = await screen.findByTestId('verdict');
    expect(verdict).toHaveTextContent('Rejected');
    expect(screen.getByText('No bowtie. The bowtie is mandatory.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Review checks' })).getByTestId('check-design')).toHaveClass('is-fail');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('needsHuman: shows “Waiting for the house” and keeps polling until the house decides', async () => {
    await signedInStudio({ studio: { reviewScenario: 'needsHuman', houseResolvesAfterPolls: 2 } });
    await uploadPiece('Patience', pngFile(9));
    await userEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    const verdict = await screen.findByTestId('verdict');
    expect(verdict).toHaveTextContent('Waiting for the house');
    expect(verdict).toHaveTextContent(/a check was skipped/);
    await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent('Hanging'), { timeout: 3000 });
    expect(screen.getByText('House decision:')).toBeInTheDocument();
  });

  it('a file that fails the byte rules cannot be submitted', async () => {
    await signedInStudio();
    await uploadPiece('Tiny', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'tiny.png', { type: 'image/png' }));
    expect(screen.getByTestId('check-size')).toHaveClass('is-fail');
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
  });
});

describe('Artist Studio: my artworks and royalties', () => {
  async function artistWithHungPiece(opts: Parameters<typeof fakes>[0] = {}) {
    const services = fakes(opts);
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    const { token, address } = await apiSignIn(services, wallet);
    const bytes = demoArtworkBytes(11);
    const created = await services.studio.createArtwork(token, { title: 'Hung Piece', contentType: 'image/png', contentLength: bytes.length });
    const hung = await services.studio.uploadContent(created.artwork.id, created.uploadToken, bytes);
    expect(hung.status).toBe('approved');
    const sessionStore = memoryStore();
    sessionStore.setItem(STUDIO_SESSION_KEY, JSON.stringify({ token, address, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), method: 'bip322-simple' }));
    return { services, wallet, token, address, artworkId: created.artwork.id, sessionStore };
  }

  it('lists the artist’s artworks with status pills and delists an approved one', async () => {
    const t = await artistWithHungPiece();
    // A second piece stuck with the house (the fake reviews per service, so park it by hand).
    const bytes = demoArtworkBytes(12);
    const c2 = await t.services.studio.createArtwork(t.token, { title: 'Pending Piece', contentType: 'image/png', contentLength: bytes.length });
    const second = await t.services.studio.uploadContent(c2.artwork.id, c2.uploadToken, bytes);
    t.services.studioState.artworks.set(second.id, { ...second, status: 'reviewing', needsHuman: true, contentUrl: null });
    renderApp(t.services, { hash: '#/studio', sessionStore: t.sessionStore });
    const list = await screen.findByRole('list', { name: 'Your artworks' });
    const hung = within(list).getByTestId(`mine-${t.artworkId}`);
    expect(hung).toHaveTextContent('Hung Piece');
    expect(hung).toHaveTextContent('Hanging');
    const pending = within(list).getByTestId(`mine-${c2.artwork.id}`);
    expect(pending).toHaveTextContent('Waiting for the house');
    expect(within(pending).queryByRole('button', { name: /Delist/ })).not.toBeInTheDocument();
    await userEvent.click(within(hung).getByRole('button', { name: 'Delist Hung Piece' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your artworks' })).getByTestId(`mine-${t.artworkId}`)).toHaveTextContent('Delisted'));
    expect(t.services.studioState.artworks.get(t.artworkId)!.status).toBe('delisted');
    await expect(t.services.studio.getContent(t.artworkId)).rejects.toMatchObject({ status: 404 });
  });

  it('royalties page: records with explorer links to the funding txid:vout, and totals', async () => {
    const t = await artistWithHungPiece();
    const tx1 = 'a1'.repeat(32);
    const tx2 = 'b2'.repeat(32);
    t.services.studio.hooks.recordRoyalty({ orderId: 'ord_1', artworkId: t.artworkId, minterAddress: 'bc1pminter1', royaltySats: 5_000, fundingTxid: tx1, vout: 1, at: '2026-09-20T10:00:00.000Z' });
    t.services.studio.hooks.recordRoyalty({ orderId: 'ord_2', artworkId: t.artworkId, minterAddress: null, royaltySats: 3_000, fundingTxid: tx2, vout: 1, at: '2026-09-21T10:00:00.000Z' });
    t.services.studio.hooks.recordRoyalty({ orderId: 'ord_2', artworkId: t.artworkId, minterAddress: null, royaltySats: 3_000, fundingTxid: tx2, vout: 1, at: '2026-09-21T10:00:00.000Z' }); // idempotent
    renderApp(t.services, { hash: '#/studio/royalties', sessionStore: t.sessionStore, app: testApp({ explorerUrl: 'https://x.test' }) });
    expect(await screen.findByRole('heading', { level: 1, name: /What the club paid you/ })).toBeInTheDocument();
    expect(await screen.findByTestId('royalty-records')).toHaveTextContent('2');
    expect(screen.getByTestId('royalty-total')).toHaveTextContent(formatSats(8_000));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]).toHaveTextContent(`${shortHash(tx2, 6)}:1`);
    expect(within(rows[0]!).getByRole('link', { name: /:1/ })).toHaveAttribute('href', `https://x.test/tx/${tx2}`);
    expect(within(rows[1]!).getByRole('link', { name: /:1/ })).toHaveAttribute('href', `https://x.test/tx/${tx1}`);
    expect(rows[1]).toHaveTextContent(formatSats(5_000));
    expect(rows[0]).toHaveTextContent('—');
  });

  it('without a session, the upload and royalties pages ask to sign in', async () => {
    const first = renderApp(fakes(), { hash: '#/studio/royalties' });
    expect(await screen.findByText('Sign in first')).toBeInTheDocument();
    expect(screen.queryByTestId('royalty-total')).not.toBeInTheDocument();
    first.unmount();
    renderApp(fakes(), { hash: '#/studio/upload' });
    expect(await screen.findByText('Sign in first')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
  });
});
