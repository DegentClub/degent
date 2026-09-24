import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderSite } from './helpers';

const H1: Array<[string, RegExp]> = [
  ['/', /The Decentralized Gentlemen Club/],
  ['/collection', /The Collection/],
  ['/atelier', /Dress your gentleman/],
  ['/comic', /This is Gentlemen- The Comic/],
  ['/manifesto', /Manifesto/],
  ['/about', /About/],
  ['/how-it-works', /Minting Rules/],
  ['/blog', /Degent Chronicles/],
  ['/blog/go-big-or-go-home', /Go Big or Go Home/],
  ['/club', /The Club/],
  ['/mint', /Mint a Degent/],
  ['/nowhere', /members only/],
];

describe('every page renders in demo mode', () => {
  it.each(H1)('%s', async (path, h1) => {
    renderSite(path);
    expect(await screen.findByRole('heading', { level: 1, name: h1 })).toBeInTheDocument();
    expect(screen.getByText('DEMO', { exact: true })).toBeInTheDocument();
    // global chrome on every page
    expect(screen.getAllByRole('link', { name: 'degent.club home' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Quick Links');
  });

  it('sets a per-page title', async () => {
    renderSite('/how-it-works');
    await screen.findByRole('heading', { level: 1, name: /Minting Rules/ });
    expect(document.title).toBe('Minting Process · degent.club');
  });
});

describe('How it works', () => {
  it('shows the four Minting Rules verbatim, the callout, three tiers and the wallets', () => {
    renderSite('/how-it-works');
    const cards = screen.getByTestId('rules-cards');
    for (const t of [
      'Square JPEG format with a minimum size of 200KB.',
      'Pepe character wearing a tuxedo with a mandatory bowtie.',
      'Must be framed and include a placard that says “DEGEN”, “DEGENT”, or “REGEN”.',
      'Mint as many as you want – create your own mini-collection!',
    ])
      expect(within(cards).getByText(t)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Did you know?' })).toBeInTheDocument();
    const table = screen.getByTestId('tiers-table');
    for (const t of ['Standard Degent', 'Large Degent', 'Full Block Degent']) expect(within(table).getByText(t)).toBeInTheDocument();
    expect(screen.getByText('XCP Wallet')).toBeInTheDocument();
    expect(screen.getByText('Horizon Wallet')).toBeInTheDocument();
    expect(within(screen.getByTestId('after-pay')).getByText('Delivered')).toBeInTheDocument();
  });
});

describe('TODO(copy) pages', () => {
  it('demo shows the placeholder and the nav links', async () => {
    renderSite('/manifesto');
    expect(screen.getByTestId('todo-copy')).toHaveTextContent('TODO(copy)');
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(within(screen.getByRole('dialog')).getByRole('link', { name: 'Manifesto' })).toBeInTheDocument();
  });

  it('production hides them from navigation until the copy ships', async () => {
    renderSite('/about', { app: { demo: false } });
    expect(screen.queryByTestId('todo-copy')).toBeNull();
    expect(screen.getByText('This page is coming soon.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('link', { name: 'About' })).toBeNull();
    expect(within(dialog).queryByRole('link', { name: 'Manifesto' })).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'The Collection' })).toBeInTheDocument();
  });

  it('production shows them once VITE_COPY_READY lists them', async () => {
    renderSite('/', { app: { demo: false, copyReady: new Set(['about'] as const) } });
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'About' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Manifesto' })).toBeNull();
  });
});

describe('Comic', () => {
  it('shows a placeholder when no inscription id is configured', () => {
    renderSite('/comic');
    expect(screen.getByText('Comic inscription not configured')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('embeds the configured inscription in a sandboxed iframe with an Ordiscan link', () => {
    const id = `${'ab'.repeat(32)}i0`;
    renderSite('/comic', { app: { comicInscriptionId: id } });
    const frame = screen.getByTitle(/The Comic \(on-chain inscription\)/);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(frame.getAttribute('src')).toContain(id);
    expect(screen.getAllByRole('link', { name: /View in Ordiscan/ })[0]).toHaveAttribute('href', `https://ordiscan.com/inscription/${id}`);
  });
});

describe('Home', () => {
  it('shows the latest mints from the membership list and the mint queue', async () => {
    renderSite('/');
    const latest = await screen.findByTestId('latest');
    expect(within(latest).getAllByRole('link')).toHaveLength(8);
    expect(within(latest).getAllByRole('link')[0]).toHaveAccessibleName('Degent #45');
    expect(await screen.findByTestId('queue-line')).toHaveTextContent(/standard lane/);
    expect(screen.getByRole('heading', { name: 'Degen Minter' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'This is Gentlemen- The Comic' })).toBeInTheDocument();
  });
});
