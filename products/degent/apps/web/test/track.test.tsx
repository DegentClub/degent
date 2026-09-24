import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ORDER_STATUSES, type OrderEvent, type OrderStatus } from '@bsh/degent-mint-sdk';
import { Timeline } from '../src/screens/Track';
import { HAPPY_PATH, STATUS_COPY } from '../src/lib/timeline';
import { preparePayment } from '../src/flow/effects';
import { flowReducer } from '../src/flow/reducer';
import { fakes, memoryStore, renderApp, stateAtQuote, testApp } from './helpers';
import type { FakeServicesOptions } from '../src/services/fakes';

function eventsUpTo(status: OrderStatus): OrderEvent[] {
  const idx = HAPPY_PATH.indexOf(status);
  const path = idx >= 0 ? HAPPY_PATH.slice(0, idx + 1) : [...HAPPY_PATH.slice(0, 6), status];
  return path.map((s, i) => ({
    status: s,
    at: new Date(Date.UTC(2026, 8, 23, 12, i)).toISOString(),
    ...(s === 'paid' ? { txid: 'c0'.repeat(32) } : {}),
    ...(s === 'revealed' ? { txid: 'ee'.repeat(32) } : {}),
  }));
}

describe('tracking timeline', () => {
  it.each([...ORDER_STATUSES])('renders status %s', (status) => {
    render(<Timeline order={{ status, timeline: eventsUpTo(status) }} explorerUrl="https://explore.block.space" />);
    const list = screen.getByRole('list', { name: 'Order timeline' });
    const step = within(list).getByTestId(`step-${status}`);
    const expected = status === 'delivered' ? 'done' : HAPPY_PATH.includes(status) ? 'current' : 'problem';
    expect(step).toHaveAttribute('data-state', expected);
    expect(within(step).getByText(STATUS_COPY[status].label)).toBeInTheDocument();
    // Timestamps are shown for every reached step.
    expect(within(step).getByText(/UTC$/)).toBeInTheDocument();
    // The funding tx link appears once payment was seen.
    const paid = within(list).getByTestId('step-paid');
    if (eventsUpTo(status).some((e) => e.status === 'paid')) {
      expect(within(paid).getByRole('link', { name: /tx c0c0c0c0/ })).toHaveAttribute('href', `https://explore.block.space/tx/${'c0'.repeat(32)}`);
    }
  });
});

async function paidAndTracking(opts: FakeServicesOptions = {}) {
  const services = fakes(opts);
  const app = testApp();
  const { state, vault } = await stateAtQuote(services, app);
  const store = memoryStore();
  const p = await preparePayment(
    { services, vault, app, store },
    { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config! },
  );
  let s = flowReducer(state, { type: 'ORDER_UPDATED', order: p.order });
  s = flowReducer(s, { type: 'RECOVERY_SAVED', bundle: p.bundle, savedLocally: true });
  s = flowReducer(s, { type: 'FUNDING_BROADCAST', txid: p.funding.txid });
  return { services, app, vault, store, state: s, bundle: p.bundle };
}

describe('Track screen', () => {
  it('follows the order to delivered and shows the on-chain rendering with a hash match', async () => {
    const t = await paidAndTracking();
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    expect(await screen.findByText('hash match ✓', {}, { timeout: 3000 })).toBeInTheDocument();
    const order = [...t.services.apiOrders.values()][0]!;
    expect(order.status).toBe('delivered');
    expect(screen.getByText(order.inscriptionId!)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'The inscription as rendered from the chain' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Your local preview' })).toBeInTheDocument();
    const revealLinks = screen.getAllByRole('link').filter((a) => a.getAttribute('href') === `https://explore.block.space/tx/${order.revealTxid}`);
    expect(revealLinks.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Mint another Degent' })).toBeInTheDocument();
  });

  it('offers one-click rescue, re-signed locally with K_e, even when the service is gone', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'rescue', rescueEndpointDown: true } });
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    expect(await screen.findByRole('heading', { name: 'Rescue your Degent' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/SIGHASH_ALL \| ANYONECANPAY/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Rescue now/ }));
    expect(await screen.findByText('Rescue broadcast')).toBeInTheDocument();
    expect(screen.getByText(/from the recovery bundle alone/)).toBeInTheDocument();
    expect(t.services.log).toContain('inscription.buildResignedRescue');
    expect(t.services.chainState.broadcasts.length).toBe(1);
  });

  it('rescue with the service reachable: inputs fetched with the in-memory token, then signed locally', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    await userEvent.click(await screen.findByRole('button', { name: /Rescue now/ }, { timeout: 3000 }));
    expect(await screen.findByText(/the mint supplied the order facts/)).toBeInTheDocument();
    expect(t.services.log).toContain('api.getRescue');
    expect(t.services.log).toContain('inscription.buildResignedRescue');
    expect(t.services.log.indexOf('api.getRescue')).toBeLessThan(t.services.log.indexOf('inscription.buildResignedRescue'));
  });

  it('without a bundle on this device, asks for the saved one and only then enables Rescue', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    const state = { ...t.state, recovery: null };
    renderApp(t.services, { initial: state, app: t.app, store: memoryStore() });
    const rescueBtn = await screen.findByRole('button', { name: /Rescue now/ }, { timeout: 3000 });
    expect(rescueBtn).toBeDisabled();
    const box = screen.getByLabelText(/paste the one you saved/);
    await userEvent.type(box, '{{}"kind": "nope"}');
    await userEvent.click(screen.getByRole('button', { name: 'Use this bundle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a degent.club recovery bundle/);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste(JSON.stringify(t.bundle));
    await userEvent.click(screen.getByRole('button', { name: 'Use this bundle' }));
    await userEvent.click(await screen.findByRole('button', { name: /Rescue now/ }));
    expect(await screen.findByText('Rescue broadcast')).toBeInTheDocument();
  });
});

describe('Track: studio artwork orders', () => {
  it('shows “Artist paid” with the funding txid:vout once the order carries royaltyPaid', async () => {
    const t = await paidAndTracking();
    const real = t.services.mintApi.getOrder.bind(t.services.mintApi);
    const txid = 'd4'.repeat(32);
    t.services.mintApi.getOrder = async (id) => ({ ...(await real(id)), artworkId: 'art_demo_chairman', edition: 7, royaltyPaid: { txid, vout: 1, sats: 5_000 } }) as never;
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    const paid = await screen.findByTestId('artist-paid');
    expect(paid).toHaveTextContent('Artist paid');
    expect(paid).toHaveTextContent('5,000 sats');
    expect(within(paid).getByRole('link', { name: /d4d4d4:1/ })).toHaveAttribute('href', `https://explore.block.space/tx/${txid}`);
    expect(screen.getByTestId('studio-order')).toHaveTextContent('Studio Degent art_demo_chairman · edition #7');
  });

  it('shows nothing about artists for a self-made Degent', async () => {
    const t = await paidAndTracking();
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    await screen.findByText('hash match ✓', {}, { timeout: 3000 });
    expect(screen.queryByTestId('artist-paid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('studio-order')).not.toBeInTheDocument();
  });
});

describe('resume from localStorage', () => {
  it('offers to resume a saved order on load and tracks it', async () => {
    const t = await paidAndTracking();
    // A fresh page load: new App, empty memory, only the store survives.
    renderApp(t.services, { app: t.app, store: t.store });
    expect(await screen.findByText('Welcome back. You have a mint in progress.')).toBeInTheDocument();
    expect(screen.getByText(t.bundle.orderId)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume tracking' }));
    expect(await screen.findByRole('heading', { level: 1, name: /From mempool to membership/ })).toBeInTheDocument();
    expect(await screen.findByText('hash match ✓', {}, { timeout: 3000 })).toBeInTheDocument();
    // No local bytes after a reload: only the on-chain rendering is shown.
    expect(screen.queryByRole('img', { name: 'Your local preview' })).not.toBeInTheDocument();
  });

  it('a resumed order can still be rescued with the token from the bundle', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    renderApp(t.services, { app: t.app, store: t.store });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume tracking' }));
    await userEvent.click(await screen.findByRole('button', { name: /Rescue now/ }, { timeout: 3000 }));
    expect(await screen.findByText(/the mint supplied the order facts/)).toBeInTheDocument();
  });

  it('shows nothing to resume when storage is empty', async () => {
    renderApp(fakes());
    expect(await screen.findByRole('button', { name: 'Start minting' })).toBeInTheDocument();
    expect(screen.queryByText(/Welcome back/)).not.toBeInTheDocument();
  });
});
