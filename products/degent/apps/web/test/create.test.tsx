import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flowReducer } from '../src/flow/reducer';
import { initialState } from '../src/flow/state';
import { laneForArtwork } from '../src/flow/effects';
import { artworkOfSize, fakes, renderApp, testApp } from './helpers';

async function atCreate(size?: number) {
  const services = fakes();
  const config = await services.mintApi.getConfig();
  const wallet = await services.wallets.connect('unisat', 'mainnet');
  let s = flowReducer(initialState(), { type: 'CONFIG_LOADED', config });
  s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
  if (size !== undefined) s = flowReducer(s, { type: 'ARTWORK_READY', artwork: await artworkOfSize(services, size) });
  s = { ...s, step: 'create' };
  return { services, config, wallet, ...renderApp(services, { initial: s, app: testApp() }) };
}

describe('Create: tier selection (ADR-0005 §3)', () => {
  it.each([
    ['standard', 'Standard Degent', '200.0 kB – 400.0 kB', 'standard lane', 'many per block'],
    ['large', 'Large Degent', '400.0 kB – 3.50 MB', 'block lane', 'shares a block'],
    ['fullblock', 'Full Block Degent', '3.50 MB – 3.90 MB', 'block lane', 'a block to itself'],
  ] as const)('offers %s as "%s" (%s, %s, %s) and selecting it re-targets the toolkit', async (tier, label, range, lane, sharing) => {
    await atCreate();
    const group = screen.getByRole('radiogroup', { name: 'Tier' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    const opt = within(group).getByTestId(`tier-${tier}`);
    expect(opt).toHaveTextContent(label);
    expect(opt).toHaveTextContent(range);
    expect(opt).toHaveTextContent(lane);
    expect(opt).toHaveTextContent(sharing);
    await userEvent.click(within(opt).getByRole('radio'));
    expect(within(opt).getByRole('radio')).toBeChecked();
    expect(opt).toHaveClass('is-on');
  });

  it('warns for Large and Full Block tiers, differently', async () => {
    await atCreate();
    const group = screen.getByRole('radiogroup', { name: 'Tier' });
    await userEvent.click(within(within(group).getByTestId('tier-large')).getByRole('radio'));
    expect(screen.getByText('Large Degents ride the block lane')).toBeInTheDocument();
    await userEvent.click(within(within(group).getByTestId('tier-fullblock')).getByRole('radio'));
    expect(screen.getByText('Full Block Degents are serious business')).toBeInTheDocument();
    expect(screen.getByText(/never shared/)).toBeInTheDocument();
    await userEvent.click(within(within(group).getByTestId('tier-standard')).getByRole('radio'));
    expect(screen.queryByText(/serious business|ride the block lane/)).not.toBeInTheDocument();
  });
});

describe('Create: honest lane message for a 397-400 KB Standard Degent', () => {
  it.each([397_000, 398_500, 400_000])('%d bytes: Standard tier, block lane, says so before the quote', async (size) => {
    const { services, config, wallet } = await atCreate(size);
    const badge = await screen.findByText('Fits Standard Degent');
    expect(badge).toBeInTheDocument();
    const art = await artworkOfSize(services, size);
    expect(art.size).toBeGreaterThanOrEqual(396_500);
    expect(art.size).toBeLessThanOrEqual(400_000);
    const { lane, weight } = laneForArtwork(services, { artwork: art, recipientAddress: wallet.ordinals.address, config, network: 'mainnet' });
    expect(lane).toBe('block');
    expect(weight).toBeGreaterThan(400_000);
    expect(screen.getByText('This Standard Degent travels the block lane')).toBeInTheDocument();
    expect(screen.getByText(/more than the 400,000 WU/)).toBeInTheDocument();
    expect(screen.getByTestId('artwork-lane')).toHaveTextContent(/WU\s+block lane/);
  });

  it('a 300 KB Standard Degent stays on the standard lane with no warning', async () => {
    await atCreate(300_000);
    await screen.findByText('Fits Standard Degent');
    expect(screen.queryByText(/travels the block lane/)).not.toBeInTheDocument();
    expect(screen.getByTestId('artwork-lane')).toHaveTextContent(/WU\s+standard lane/);
  });
});
