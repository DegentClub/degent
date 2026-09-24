import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
});

describe('demo mode: the whole flow, end to end, through the UI', () => {
  it('home → welcome → connect → create (Atelier) → validate → quote → pay → track (delivered) → the collection', async () => {
    const user = userEvent.setup();
    const log: string[] = [];
    const services = fakes({ log });
    const { store } = renderApp(services, { app: testApp(), path: '/' });

    // 0 · Home: the certified numbers, then in through the front door
    expect(screen.getByRole('heading', { level: 1, name: 'Decentralized Gentlemen Club' })).toBeInTheDocument();
    expect(await screen.findByTestId('stat-minted')).toHaveTextContent('4,112');
    await user.click(within(screen.getByRole('main')).getAllByRole('link', { name: 'Mint Now' })[0]!);

    // 1 · Welcome
    expect(await screen.findByRole('heading', { level: 1, name: /Mint a Degent/ })).toBeInTheDocument();
    expect(screen.getByText('DEMO')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Standard Degent' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Block Degent' })).toBeInTheDocument();
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
    // The Atelier: upload a picture, gold frame + DEGENT placard, JPEG fitted to the Standard range.
    await user.upload(screen.getByLabelText('Upload a picture for the Atelier'), new File([new Uint8Array([1, 2, 3])], 'gent.png', { type: 'image/png' }));
    await screen.findByTestId('atelier-readout', {}, { timeout: 3000 });
    const useDesign = screen.getByRole('button', { name: 'Use this design' });
    await waitFor(() => expect(useDesign).toBeEnabled());
    await user.click(useDesign);
    expect(await screen.findByText('Fits Standard Degent', {}, { timeout: 3000 })).toBeInTheDocument();
    const img = screen.getByRole('img', { name: 'Preview rendered from the exact bytes to be inscribed' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(screen.getByText('image/jpeg')).toBeInTheDocument();
    for (const cb of screen.getAllByRole('checkbox')) if (!(cb as HTMLInputElement).checked) await user.click(cb);
    expect(screen.getByTestId('rule-format')).toHaveAttribute('data-satisfied', 'true');
    expect(screen.getByTestId('rule-design')).toHaveAttribute('data-satisfied', 'true');
    expect(screen.getByTestId('rule-framing')).toHaveAttribute('data-satisfied', 'true');
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
    const prepare = screen.getByRole('button', { name: 'Prepare payment' });
    expect(prepare).toBeDisabled(); // a recovery passphrase comes first (ADR-0005)
    await user.type(screen.getByLabelText('Recovery passphrase'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('Repeat the passphrase'), 'correct horse battery staple');
    await user.click(prepare);
    const bundleText = (await screen.findByLabelText('Recovery bundle (JSON)')) as HTMLTextAreaElement;
    const bundle = JSON.parse(bundleText.value);
    expect(bundle.kind).toBe('degent.club/recovery');
    expect(bundle.orderToken).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.version).toBe(2);
    expect(bundle.revealKey).toMatchObject({ alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations: 600_000 });
    expect(bundleText.value).not.toContain('correct horse');
    expect(screen.getByText('Keep it private')).toBeInTheDocument();
    expect(loadRecovery(store)?.orderId).toBe(bundle.orderId);
    expect(log).not.toContain('wallet.signPsbt');
    const sign = screen.getByRole('button', { name: 'Sign & broadcast with UniSat' });
    expect(sign).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I have kept a copy/ }));
    await user.click(sign);

    // 7 · Track: Design -> Mint -> Confirm -> Approve, with the members' votes arriving live
    expect(await screen.findByRole('heading', { level: 1, name: /From mempool to membership/ })).toBeInTheDocument();
    const stages = screen.getByRole('list', { name: 'Mint stages' });
    expect(within(stages).getAllByRole('listitem').map((li) => li.textContent?.split(' — ')[0]?.replace(/^\d/, ''))).toEqual(
      expect.arrayContaining([expect.stringContaining('Design'), expect.stringContaining('Mint'), expect.stringContaining('Confirm'), expect.stringContaining('Approve')]),
    );
    expect(await screen.findByText(/of 3 members have approved/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect((await screen.findAllByText('Degent #4113', {}, { timeout: 4000 })).length).toBeGreaterThan(0);
    expect(await screen.findByText('hash match ✓', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Welcome to the club.' })).toBeInTheDocument();
    expect(screen.getByTestId('stage-approve')).toHaveAttribute('data-state', 'done');
    // Share card on delivery
    const card = screen.getByTestId('share-card');
    expect(within(card).getByRole('heading', { name: 'Degent #4113' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Share on X/ })).toHaveAttribute('href', expect.stringContaining('twitter.com/intent/tweet'));
    expect(within(card).getByRole('link', { name: 'View in the collection' })).toHaveAttribute('href', 'https://degent.club/collection/4113');
    const order = [...services.apiOrders.values()][0]!;
    expect(order.timeline.map((e) => e.status)).toEqual([
      'awaiting_content', 'reviewing', 'approved', 'awaiting_payment', 'paid', 'confirming', 'member_review', 'queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered',
    ]);
    expect(services.apiVotes.get(order.id)!.map((v) => v.degent)).toEqual([17, 808, 2049]);

    // The money path happened in the only safe order.
    const at = (n: string) => log.indexOf(n);
    expect(at('api.submitReveal')).toBeLessThan(at('wallet.signPsbt'));
    expect(at('chain.broadcast')).toBeGreaterThan(at('wallet.signPsbt'));
    // The token never leaked into the call log.
    expect(log.join(' ')).not.toContain(bundle.orderToken);

    // 8 · The new member hangs in the collection, with its on-chain details.
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Site menu' })).getByRole('link', { name: 'The Collection' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'The Collection' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('showing')).toHaveTextContent('Showing 1–20 of 4,113'));
    await user.selectOptions(screen.getByLabelText('Sort'), 'n:desc');
    await user.click(await screen.findByRole('button', { name: 'Open Degent #4113' }));
    const box = screen.getByRole('dialog', { name: 'DEGENT #4113' });
    expect(within(box).getByText(order.inscriptionId!)).toBeInTheDocument();
    expect(within(box).getByText('Child of the club parent · the Register')).toBeInTheDocument();
  }, 40_000);
});
