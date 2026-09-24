import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readConfig } from '../src/config';
import { createDemoServices } from '../src/services';
import { loadRecovery } from '../src/lib/recovery';
import { fakes, renderApp, testApp } from './helpers';

describe('config', () => {
  it('?demo=1 switches to demo services; env vars configure the live ones', () => {
    const demo = readConfig({}, '?demo=1');
    expect(demo.demo).toBe(true);
    expect(createDemoServices(demo).mode).toBe('demo');
    const live = readConfig(
      { VITE_MINT_API_URL: 'https://mint.degent.club/', VITE_NETWORK: 'signet', VITE_EXPLORER_URL: 'https://x.test/' },
      '',
    );
    expect(live).toMatchObject({
      demo: false,
      network: 'signet',
      mintApiUrl: 'https://mint.degent.club',
      esploraUrl: 'https://mempool.space/signet/api',
      explorerUrl: 'https://x.test',
    });
    expect(readConfig({ VITE_NETWORK: 'bogus' }, '').network).toBe('mainnet');
    expect(readConfig({}, '').explorerUrl).toBe('https://explore.block.space');
  });

  it('VITE_DEMO_DEFAULT=1 (the GitHub Pages build) makes demo the default; ?demo=0 still reaches live', () => {
    expect(readConfig({ VITE_DEMO_DEFAULT: '1' }, '').demo).toBe(true);
    expect(readConfig({ VITE_DEMO_DEFAULT: 'true' }, '?utm=x').demo).toBe(true);
    expect(readConfig({ VITE_DEMO_DEFAULT: '1' }, '?demo=0').demo).toBe(false);
    expect(readConfig({ VITE_DEMO_DEFAULT: '0' }, '').demo).toBe(false);
    expect(readConfig({}, '?demo=false').demo).toBe(false);
    expect(readConfig({}, '?demo=true').demo).toBe(true);
  });
});

describe('demo mode: the whole flow, end to end, through the UI', () => {
  it('welcome → connect → create → validate → quote → pay → track (delivered, hash match)', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    const services = fakes({ log });
    const { store } = renderApp(services, { app: testApp() });

    // 1 · Welcome
    expect(screen.getByText('DEMO')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Standard Degent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Large Degent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Full Block Degent' })).toBeInTheDocument();
    expect(await screen.findByText('3 waiting')).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Start minting' });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);

    // 2 · Connect
    expect(await screen.findByRole('heading', { level: 1, name: /Present your credentials/ })).toHaveFocus();
    expect(screen.getByRole('link', { name: /Install Leather/ })).toHaveAttribute('href', expect.stringContaining('leather.io'));
    await user.click(screen.getByRole('button', { name: 'Connect UniSat' }));
    expect(await screen.findByText('Connected: UniSat')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Create' }));

    // 3 · Create
    await screen.findByRole('heading', { level: 1, name: /Dress the gentleman/ });
    await user.upload(screen.getByLabelText('Upload artwork'), new File([new Uint8Array([1, 2, 3])], 'gent.png', { type: 'image/png' }));
    expect(await screen.findByText('Fits Standard Degent', {}, { timeout: 3000 })).toBeInTheDocument();
    const img = screen.getByRole('img', { name: 'Preview rendered from the exact bytes to be inscribed' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(screen.getByText('image/webp')).toBeInTheDocument();
    for (const cb of screen.getAllByRole('checkbox')) await user.click(cb);
    await user.click(screen.getByRole('button', { name: 'Continue to Validate' }));

    // 4 · Validate
    await screen.findByRole('heading', { level: 1, name: /inspection/ });
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'See your quote' }));

    // 5 · Quote
    await screen.findByRole('heading', { level: 1, name: /The bill, itemised/ });
    expect(await screen.findByText('✓ Verified: matches service')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to Pay' }));

    // 6 · Pay
    await screen.findByRole('heading', { level: 1, name: /Settle the account/ });
    await user.click(screen.getByRole('button', { name: 'Prepare payment' }));
    const bundleText = (await screen.findByLabelText('Recovery bundle (JSON)')) as HTMLTextAreaElement;
    const bundle = JSON.parse(bundleText.value);
    expect(bundle.kind).toBe('degent.club/recovery');
    expect(bundle.version).toBe(2);
    expect(bundle.orderToken).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.revealPrivkey).toMatch(/^[0-9a-f]{64}$/);
    expect(screen.getByText('Keep it private — it holds a key')).toBeInTheDocument();
    expect(screen.getByText(/What that key can do/)).toBeInTheDocument();
    expect(loadRecovery(store)?.orderId).toBe(bundle.orderId);
    expect(log).not.toContain('wallet.signPsbt');
    const sign = screen.getByRole('button', { name: 'Sign & broadcast with UniSat' });
    expect(sign).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I have kept a copy/ }));
    await user.click(sign);

    // 7 · Track
    expect(await screen.findByRole('heading', { level: 1, name: /From mempool to membership/ })).toBeInTheDocument();
    expect(await screen.findByText('hash match ✓', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Welcome to the club.' })).toBeInTheDocument();

    // The money path happened in the only safe order.
    const at = (n: string) => log.indexOf(n);
    expect(at('api.submitReveal')).toBeLessThan(at('wallet.signPsbt'));
    expect(at('chain.broadcast')).toBeGreaterThan(at('wallet.signPsbt'));
    // The token never leaked into the call log.
    expect(log.join(' ')).not.toContain(bundle.orderToken);
  });
});
