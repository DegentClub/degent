import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { artworkOfSize, fakes, renderApp, stateAtQuote, testApp } from './helpers';
import { formatBtc, formatSats } from '../src/lib/format';

describe('Quote screen', () => {
  it('renders the exact breakdown in sats and BTC and verifies the commit address', async () => {
    const services = fakes();
    const app = testApp();
    const { state, vault } = await stateAtQuote(services, app);
    const q = state.order!.quote!;
    renderApp(services, { initial: state, vault, app });

    expect(await screen.findByRole('heading', { level: 1, name: /The bill, itemised/ })).toBeInTheDocument();
    const revealFee = screen.getByTestId('reveal-fee');
    expect(revealFee).toHaveTextContent(formatSats(q.revealFeeSats));
    expect(revealFee).toHaveTextContent(formatBtc(q.revealFeeSats));
    const total = screen.getByTestId('total');
    expect(total).toHaveTextContent(formatSats(q.totalSats));
    expect(total).toHaveTextContent(formatBtc(q.totalSats));
    expect(q.totalSats).toBe(q.revealFeeSats + q.postageSats + q.serviceFeeSats);
    expect(screen.getAllByText(`${q.revealVsize.toLocaleString('en-US')} vB`, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByRole('timer')).toHaveTextContent(/^1[45]:\d\d$/);

    expect(await screen.findByText('✓ Verified: matches service')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Pay' })).toBeEnabled();
  });

  it('blocks payment when the service commit address does not match', async () => {
    const services = fakes({ mint: { tamperCommit: true } });
    const app = testApp();
    const { state, vault } = await stateAtQuote(services, app);
    renderApp(services, { initial: state, vault, app });
    expect(await screen.findByText('Blocked: commit address mismatch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Pay' })).toBeDisabled();
    expect(screen.queryByText(/Verified: matches service/)).not.toBeInTheDocument();
  });

  it('Large Degents show the block slot, ETA and a cost warning', async () => {
    const services = fakes({ images: { fullSize: 6_000_000, width: 3000, height: 3000 } });
    const app = testApp();
    // stateAtQuote encodes at q=0.2 → ~1.58 MB, a Large Degent.
    const { state, vault } = await stateAtQuote(services, app, undefined, 'large');
    expect(state.order!.tier).toBe('large');
    expect(state.order!.quote!.lane).toBe('block');
    renderApp(services, { initial: state, vault, app });
    expect(await screen.findByText('Large Degent: read this twice')).toBeInTheDocument();
    expect(screen.getByText(/Large Degent · block lane/)).toBeInTheDocument();
    expect(screen.getByText('4th block')).toBeInTheDocument();
    expect(screen.getByText('~40 min')).toBeInTheDocument();
    expect(screen.getByText(/an estimate, not a promise/)).toBeInTheDocument();
    expect(screen.queryByText(/travels the block lane/)).not.toBeInTheDocument();
  });

  it('Full Block Degents say they take a block alone', async () => {
    const services = fakes({ images: { fullSize: 6_000_000, width: 3000, height: 3000 } });
    const app = testApp();
    const art = await artworkOfSize(services, 3_600_000, 6_000_000);
    expect(art.size).toBeGreaterThanOrEqual(3_500_000);
    const { state, vault } = await stateAtQuote(services, app, undefined, 'fullblock', art);
    expect(state.order!.tier).toBe('fullblock');
    renderApp(services, { initial: state, vault, app });
    expect(await screen.findByText('Full Block Degent: read this twice')).toBeInTheDocument();
    expect(screen.getByText('Block lane (a block of its own)')).toBeInTheDocument();
  });

  it('a Standard Degent of ~398 KB is quoted honestly on the block lane', async () => {
    const services = fakes();
    const app = testApp();
    const art = await artworkOfSize(services, 398_000);
    expect(art.size).toBeGreaterThanOrEqual(397_000);
    expect(art.size).toBeLessThanOrEqual(400_000);
    const { state, vault } = await stateAtQuote(services, app, undefined, 'standard', art);
    expect(state.order!.tier).toBe('standard');
    expect(state.order!.quote!.lane).toBe('block');
    renderApp(services, { initial: state, vault, app });
    expect(await screen.findByText('Your Standard Degent travels the block lane')).toBeInTheDocument();
    expect(screen.getByText(/Standard Degent · block lane/)).toBeInTheDocument();
    expect(screen.getByText(/over the 400,000 WU limit/)).toBeInTheDocument();
    expect(screen.getByText('4th block')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Pay' })).toBeEnabled();
  });

  it('custom fee rate is clamped to the minimum and requires a re-quote before paying', async () => {
    const services = fakes();
    const app = testApp();
    const { state, vault } = await stateAtQuote(services, app);
    renderApp(services, { initial: state, vault, app });
    await screen.findByText('✓ Verified: matches service');
    const group = screen.getByRole('radiogroup', { name: 'Fee rate' });
    await userEvent.click(within(group).getByRole('radio', { name: /Custom/ }));
    const input = screen.getByLabelText('Custom rate (sat/vB)');
    await userEvent.clear(input);
    await userEvent.type(input, '0.2{Enter}');
    expect(input).toHaveValue(1);

    await userEvent.click(within(group).getByRole('radio', { name: /Priority/ }));
    expect(await screen.findByText('Re-quote at 9 sat/vB?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Pay' })).toBeDisabled();
    const before = state.order!.id;
    await userEvent.click(screen.getByRole('button', { name: 'Re-quote at 9 sat/vB' }));
    await waitFor(() => expect(screen.queryByText(/Re-quote at 9/)).not.toBeInTheDocument());
    expect([...services.apiOrders.keys()].filter((k) => k !== before)).toHaveLength(1);
    expect(await screen.findByText('✓ Verified: matches service')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to Pay' })).toBeEnabled();
  });
});
