/**
 * "Notify me" (order notifications, POST /v1/orders/{id}/subscriptions): the preference on Welcome, the panel
 * on Track (subscribes with the order token, automatically for the Welcome choice), and /track/:id on a device
 * without the token.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { preparePayment } from '../src/flow/effects';
import { flowReducer } from '../src/flow/reducer';
import { initialState } from '../src/flow/state';
import { createKeyVault } from '../src/flow/keyVault';
import type { FakeServicesOptions } from '../src/services/fakes';
import { fakes, memoryStore, renderApp, stateAtQuote, testApp } from './helpers';

const PASS = 'correct horse battery staple';

async function paidAndTracking(opts: FakeServicesOptions = {}) {
  const services = fakes(opts);
  const app = testApp();
  const { state, vault } = await stateAtQuote(services, app);
  const store = memoryStore();
  const p = await preparePayment(
    { services, vault, app, store },
    { order: state.order!, artwork: state.artwork!, wallet: state.wallet!, config: state.config!, passphrase: PASS },
  );
  let s = flowReducer(state, { type: 'ORDER_UPDATED', order: p.order });
  s = flowReducer(s, { type: 'RECOVERY_SAVED', bundle: p.bundle, savedLocally: true });
  s = flowReducer(s, { type: 'FUNDING_BROADCAST', txid: p.funding.txid });
  return { services, app, vault, store, state: s, orderId: p.order.id };
}

describe('Notify me on Track', () => {
  it('subscribes the order by email with its token and lists the subscription', async () => {
    const user = userEvent.setup();
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    const panel = await screen.findByTestId('notify-panel');
    expect(within(panel).getByText(/when your Degent is with the club, if the members decline it, if self-rescue opens, and when it joins the club/)).toBeInTheDocument();
    await user.type(within(panel).getByLabelText('Email address'), 'gent@example.com');
    await user.click(within(panel).getByRole('button', { name: 'Notify me' }));
    const list = await within(panel).findByRole('list', { name: 'Notifications for this order' });
    expect(within(list).getByText('gent@example.com')).toBeInTheDocument();
    const subs = [...(t.services.mintApi as unknown as { subscriptions: Map<string, { orderId: string; channel: string }> }).subscriptions.values()];
    expect(subs).toEqual([expect.objectContaining({ orderId: t.orderId, channel: 'email' })]);
    expect(t.services.log).toContain('api.subscribeOrder:email');
  });

  it('shows the service refusal (e.g. an invalid Telegram chat id)', async () => {
    const user = userEvent.setup();
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    renderApp(t.services, { initial: t.state, app: t.app, vault: t.vault, store: t.store });
    const panel = await screen.findByTestId('notify-panel');
    await user.click(within(panel).getByRole('radio', { name: 'Telegram' }));
    await user.type(within(panel).getByLabelText('Telegram chat id'), 'not a chat');
    await user.click(within(panel).getByRole('button', { name: 'Notify me' }));
    expect(await within(panel).findByText(/invalid telegram chat id/)).toBeInTheDocument();
  });

  it('subscribes the choice made on Welcome automatically, once the order exists', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    const initial = flowReducer(t.state, { type: 'NOTIFY_PREF_SET', pref: { channel: 'telegram_chat', address: '123456789' } });
    renderApp(t.services, { initial, app: t.app, vault: t.vault, store: t.store });
    const panel = await screen.findByTestId('notify-panel');
    expect(await within(panel).findByText('123456789')).toBeInTheDocument();
    await waitFor(() => expect(t.services.log.filter((l) => l === 'api.subscribeOrder:telegram_chat')).toHaveLength(1));
  });

  it('/track/:id on a device without the order token explains why it cannot subscribe', async () => {
    const t = await paidAndTracking({ mint: { scenario: 'rescue' } });
    renderApp(t.services, { app: t.app, vault: createKeyVault(), store: memoryStore(), path: `/track/${t.orderId}` });
    const panel = await screen.findByTestId('notify-panel', {}, { timeout: 3000 });
    expect(within(panel).getByText(/tied to this order’s private token/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Notify me' })).not.toBeInTheDocument();
    expect(screen.getByText(new RegExp(t.orderId))).toBeInTheDocument();
  });
});

describe('Notify me on Welcome', () => {
  it('remembers the choice in memory (never in localStorage) until the order exists', async () => {
    const user = userEvent.setup();
    const store = memoryStore();
    renderApp(fakes(), { store });
    const pref = await screen.findByTestId('notify-pref');
    await user.type(within(pref).getByLabelText('Email address'), 'gent@example.com');
    await user.click(within(pref).getByRole('button', { name: 'Notify me about my order' }));
    expect(within(pref).getByRole('status')).toHaveTextContent('We will notify gent@example.com (Email) once your order exists.');
    expect([...store.map.values()].join('')).not.toContain('gent@example.com');
    await user.click(within(pref).getByRole('button', { name: 'Change' }));
    expect(within(pref).getByRole('button', { name: 'Notify me about my order' })).toBeInTheDocument();
  });

  it('reducer: NOTIFY_PREF_SET sets and clears; RESET forgets it', () => {
    let s = flowReducer(initialState(), { type: 'NOTIFY_PREF_SET', pref: { channel: 'email', address: 'a@b.co' } });
    expect(s.notifyPref).toEqual({ channel: 'email', address: 'a@b.co' });
    s = flowReducer(s, { type: 'RESET' });
    expect(s.notifyPref).toBeNull();
  });
});

describe('real adapters', () => {
  it('MintApi.subscribeOrder posts to /v1/orders/{id}/subscriptions with the order token; refuses without one', async () => {
    const { createRealMintApi } = await import('../src/services/real/mintApi');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createRealMintApi('https://mint.test', async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: 'sub_x', orderId: 'o1', channel: 'email', address: 'a@b.co', events: [], createdAt: '2026-09-24T00:00:00Z' }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    await api.subscribeOrder('o1', 'tok', { channel: 'email', address: 'a@b.co' });
    expect(calls[0]!.url).toBe('https://mint.test/v1/orders/o1/subscriptions');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await expect(api.subscribeOrder('o1', '', { channel: 'email', address: 'a@b.co' })).rejects.toThrow(/Missing order token/);
  });

  it('ChainApi.getInscriptionInfo reads ord /r/inscription and tolerates missing fields', async () => {
    const { createEsploraChain, parseOrdInscription } = await import('../src/services/real/chain');
    const id = `${'a'.repeat(64)}i0`;
    const chain = createEsploraChain('https://esplora.test', 'https://ord.test', async (url) => {
      expect(url).toBe(`https://ord.test/r/inscription/${id}`);
      return new Response(JSON.stringify({ id, content_type: 'image/jpeg', content_length: 312_000, fee: 80_123, height: 840_001, number: 93_000_001, timestamp: 1_713_600_000 }));
    });
    expect(await chain.getInscriptionInfo(id)).toEqual({
      id,
      contentType: 'image/jpeg',
      contentLength: 312_000,
      fee: 80_123,
      height: 840_001,
      number: 93_000_001,
      timestamp: '2024-04-20T08:00:00.000Z',
    });
    expect(parseOrdInscription(id, {})).toEqual({ id, contentType: null, contentLength: null, fee: null, height: null, number: null, timestamp: null });
  });
});
