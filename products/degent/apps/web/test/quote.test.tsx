import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakes, renderApp, stateAtQuote, testApp } from './helpers';
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

  it('Block Degents show queue position, ETA and a cost warning', async () => {
    const services = fakes({ images: { fullSize: 6_000_000, width: 3000, height: 3000 } });
    const app = testApp();
    // stateAtQuote encodes at q=0.2 → ~1.4 MB, a Block-sized file.
    const { state, vault } = await stateAtQuote(services, app, undefined, 'block');
    expect(state.order!.quote!.lane).toBe('block');
    renderApp(services, { initial: state, vault, app });
    expect(await screen.findByText('Block Degent: read this twice')).toBeInTheDocument();
    expect(screen.getByText('4th in line')).toBeInTheDocument();
    expect(screen.getByText('~40 min')).toBeInTheDocument();
    expect(screen.getByText(/an estimate, not a promise/)).toBeInTheDocument();
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
