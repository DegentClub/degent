import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flowReducer } from '../src/flow/reducer';
import { initialState, type FlowState } from '../src/flow/state';
import { ART_BRIEF, runLocalRules } from '../src/lib/rules';
import { demoConfig } from '../src/services/fakes';
import { fakes, renderApp, standardArtwork, testApp } from './helpers';

async function atStep(step: 'create' | 'validate', mutate?: (s: FlowState) => FlowState) {
  const services = fakes();
  const config = await services.mintApi.getConfig();
  const wallet = await services.wallets.connect('unisat', 'mainnet');
  let s = flowReducer(initialState(), { type: 'CONFIG_LOADED', config });
  s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
  s = flowReducer(s, { type: 'ARTWORK_READY', artwork: await standardArtwork(services) });
  s = { ...s, step };
  if (mutate) s = mutate(s);
  return { services, ...renderApp(services, { initial: s, app: testApp() }) };
}

describe('local rules (mint-sdk validateContentMeta + byte checks)', () => {
  it('passes a Standard-sized WebP and fails an undersized one', async () => {
    const services = fakes();
    const art = await standardArtwork(services);
    const cfg = demoConfig('mainnet');
    const ok = runLocalRules(art, 'standard', cfg);
    expect(ok.every((c) => c.passed)).toBe(true);
    expect(ok.map((c) => c.id)).toEqual(expect.arrayContaining(['content_type', 'size', 'tier', 'width', 'height', 'magic_bytes', 'sha256']));

    const small = { ...art, size: 150_000 };
    const bad = runLocalRules(small, 'standard', cfg);
    expect(bad.find((c) => c.id === 'size')!.passed).toBe(false);
    expect(bad.find((c) => c.id === 'length')!.passed).toBe(false);

    const wrongTier = runLocalRules(art, 'block', cfg);
    expect(wrongTier.find((c) => c.id === 'tier')!.passed).toBe(false);
  });

  it('shows every local check with pass/fail on the Validate screen', async () => {
    await atStep('validate');
    const list = await screen.findByRole('list', { name: 'Local rule checks' });
    const items = within(list).getAllByRole('listitem');
    expect(items.length).toBeGreaterThanOrEqual(7);
    expect(within(list).getAllByText(/: passed/)).toHaveLength(items.length);
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeEnabled();
  });

  it('disables review when a rule fails and says why', async () => {
    await atStep('validate', (s) => ({ ...s, artwork: { ...s.artwork!, contentType: 'image/bmp' } }));
    const list = await screen.findByRole('list', { name: 'Local rule checks' });
    expect(within(list).getByTestId('check-content_type')).toHaveClass('is-fail');
    expect(within(list).getByTestId('check-magic_bytes')).toHaveClass('is-fail');
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled();
    expect(screen.getByText('Fix these before review')).toBeInTheDocument();
  });

  it('shows the review results from the service, and a rejection costs nothing', async () => {
    const services = fakes({ mint: { scenario: 'reject' } });
    const config = await services.mintApi.getConfig();
    const wallet = await services.wallets.connect('unisat', 'mainnet');
    let s = flowReducer(initialState(), { type: 'CONFIG_LOADED', config });
    s = flowReducer(s, { type: 'WALLET_CONNECTED', wallet });
    s = { ...flowReducer(s, { type: 'ARTWORK_READY', artwork: await standardArtwork(services) }), step: 'validate' };
    renderApp(services, { initial: s });
    await userEvent.click(await screen.findByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/you have paid nothing/i)).toBeInTheDocument();
    expect(screen.getByText('No bowtie. The bowtie is mandatory.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'See your quote' })).not.toBeInTheDocument();
  });

  it('renders the art brief as a checklist that gates Continue', async () => {
    await atStep('create');
    for (const b of ART_BRIEF) expect(screen.getByRole('checkbox', { name: new RegExp(b.label.slice(0, 12)) })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Bowtie — mandatory/ })).toBeInTheDocument();
    const cont = screen.getByRole('button', { name: 'Continue to Validate' });
    expect(cont).toBeDisabled();
    for (const cb of screen.getAllByRole('checkbox')) await userEvent.click(cb);
    expect(cont).toBeEnabled();
  });
});

describe('standard-lane-only service (no block tier offered)', () => {
  it('the welcome page shows only the Standard Degent tier', async () => {
    const services = fakes();
    const cfg = await services.mintApi.getConfig();
    services.mintApi.getConfig = async () => ({ ...cfg, tiers: cfg.tiers.filter((t) => t.tier !== 'block') });
    renderApp(services);
    expect(await screen.findByRole('button', { name: 'Start minting' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Standard Degent' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Block Degent' })).not.toBeInTheDocument();
  });
});
