/**
 * Read-only mint mode (site/mintMode.tsx, docs/SERVER.md) and the test-network banner: the runtime `mode` from
 * /v1/config drives the Mint calls to action, /mint, /review and /club; VITE_MINT_MODE is only the hint until the
 * API answers; one build serves both modes.
 */
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readConfig, safeHttpUrl } from '../src/config';
import { flowReducer } from '../src/flow/reducer';
import { initialState } from '../src/flow/state';
import { demoConfig } from '../src/services/fakes';
import { fakes, renderApp, testApp } from './helpers';

const BETA = 'https://signet.degent.club';

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const readonlyServices = (o: Parameters<typeof fakes>[0] = {}) => fakes({ ...o, mint: { ...(o.mint ?? {}), mode: 'readonly' } });

describe('config', () => {
  it('VITE_MINT_MODE is a hint (default full); VITE_BETA_URL must be an https URL', () => {
    expect(readConfig({}, '').mintMode).toBe('full');
    expect(readConfig({ VITE_MINT_MODE: 'readonly' }, '').mintMode).toBe('readonly');
    expect(readConfig({ VITE_MINT_MODE: 'weird' }, '').mintMode).toBe('full');
    expect(readConfig({ VITE_BETA_URL: 'https://signet.degent.club/' }, '').betaUrl).toBe(BETA);
    expect(readConfig({}, '').betaUrl).toBe('');
    expect(safeHttpUrl('javascript:alert(1)')).toBe('');
    expect(safeHttpUrl('http://evil.example')).toBe('');
    expect(safeHttpUrl('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('the runtime mode from /v1/config lands in the flow state (absent = full)', () => {
    const cfg = demoConfig('mainnet');
    expect(flowReducer(initialState(), { type: 'CONFIG_LOADED', config: { ...cfg, mode: 'readonly' } }).mintMode).toBe('readonly');
    expect(flowReducer(initialState(), { type: 'CONFIG_LOADED', config: cfg }).mintMode).toBe('full');
    expect(initialState().mintMode).toBeNull();
  });
});

describe('read-only mint (runtime mode from the API)', () => {
  it('every Mint call to action says "Minting opens soon" and links to the signet beta', async () => {
    renderApp(readonlyServices(), { path: '/', app: testApp({ betaUrl: BETA }) });
    await settle();
    const header = screen.getByRole('banner');
    await waitFor(() => expect(within(header).getByRole('link', { name: /Minting opens soon/ })).toHaveAttribute('href', BETA));
    const ctas = screen.getAllByRole('link', { name: /Minting opens soon/ });
    expect(ctas.length).toBeGreaterThanOrEqual(3);
    for (const a of ctas) {
      expect(a).toHaveAttribute('href', BETA);
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(screen.queryByRole('link', { name: /^Mint Now/ })).toBeNull();
  });

  it('without a beta URL the calls to action go to the /mint explainer', async () => {
    renderApp(readonlyServices(), { path: '/collection' });
    await settle();
    const links = await screen.findAllByRole('link', { name: 'Minting opens soon' });
    for (const a of links) expect(a).toHaveAttribute('href', '/mint');
  });

  it('/mint explains instead of running the wizard (no progress nav, no wallet step)', async () => {
    const log: string[] = [];
    renderApp(readonlyServices({ log }), { path: '/mint', app: testApp({ betaUrl: BETA }) });
    expect(await screen.findByTestId('mint-closed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Minting opens soon');
    expect(screen.getByRole('link', { name: /Open the signet beta/ })).toHaveAttribute('href', BETA);
    expect(screen.queryByRole('navigation', { name: /progress/i })).toBeNull();
    expect(log.filter((l) => /createOrder|connect/.test(l))).toEqual([]);
  });

  it('/review explains that membership review opens with minting and never asks for a sign-in', async () => {
    const log: string[] = [];
    renderApp(readonlyServices({ log }), { path: '/review', app: testApp({ betaUrl: BETA }) });
    expect(await screen.findByTestId('review-closed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Membership review opens with minting');
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
    expect(log.filter((l) => /auth|Review/.test(l))).toEqual([]);
  });

  it('/club looks holdings up by address (public Register read), no sign-in', async () => {
    const services = readonlyServices();
    const address = (await services.wallets.connect('unisat', 'mainnet')).ordinals.address;
    renderApp(services, { path: '/club' });
    await settle();
    expect(screen.queryByRole('button', { name: /Sign in to the club/ })).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Ordinals address'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText('That does not look like a taproot (ordinals) address.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Ordinals address'));
    await user.type(screen.getByLabelText('Ordinals address'), address);
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    const list = await screen.findByRole('list', { name: 'Degents at this address' });
    expect(within(list).getAllByRole('link').length).toBeGreaterThan(0);
    expect(services.log.filter((l) => /auth/.test(l))).toEqual([]);
  });

  it('Collection, Explorer, How it works and Comic still render', async () => {
    for (const path of ['/collection', '/explorer', '/how-it-works', '/comic', '/']) {
      const { unmount } = renderApp(readonlyServices(), { path });
      await settle();
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      unmount();
    }
  });
});

describe('the runtime answer wins over the build hint', () => {
  it('a readonly hint with a full API shows the wizard once /v1/config answers', async () => {
    renderApp(fakes(), { path: '/', app: testApp({ mintMode: 'readonly' }) });
    await settle();
    await waitFor(() => expect(within(screen.getByRole('banner')).getByRole('link', { name: /Mint/ })).toHaveAttribute('href', '/mint'));
    expect(screen.queryByRole('link', { name: /Minting opens soon/ })).toBeNull();
  });

  it('full mode keeps "Mint Now" linking to /mint', async () => {
    renderApp(fakes(), { path: '/' });
    await settle();
    for (const a of screen.getAllByRole('link', { name: /^Mint Now/ })) expect(a).toHaveAttribute('href', '/mint');
  });
});

describe('test-network banner', () => {
  it('signet builds show "Test network: signet coins have no value" on every page', async () => {
    for (const path of ['/', '/mint', '/collection']) {
      const { unmount } = renderApp(fakes({ network: 'signet' }), { path, app: testApp({ network: 'signet' }) });
      await settle();
      expect(screen.getByTestId('testnet-banner')).toHaveTextContent('Test network: signet coins have no value');
      unmount();
    }
  });

  it('mainnet builds show none', async () => {
    renderApp(fakes(), { path: '/' });
    await settle();
    expect(screen.queryByTestId('testnet-banner')).toBeNull();
  });
});
