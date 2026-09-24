import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderSite, ITEMS } from './helpers';
import { fakes } from '../helpers';
import { SIWB_STATEMENT } from '../../src/site/lib/siwb';

function spyWallets(installed: Array<'unisat' | 'xverse' | 'horizon' | 'xcp'>) {
  const mint = fakes({ wallet: { installed } });
  const signed: Array<{ message: string; address: string; type?: string }> = [];
  const orig = mint.wallets.connect.bind(mint.wallets);
  mint.wallets.connect = async (id, net) => {
    const s = await orig(id, net);
    const sign = s.signMessage!.bind(s);
    s.signMessage = async (message, address, type) => {
      signed.push({ message, address, ...(type ? { type } : {}) });
      return sign(message, address, type);
    };
    return s;
  };
  return { mint, signed };
}

describe('Club: sign in with Bitcoin', () => {
  it('BIP-322 with the ordinals address, then lists only the Degents held (membership intersection)', async () => {
    const { mint, signed } = spyWallets(['unisat']);
    const held = [ITEMS[6]!.id, `${'cd'.repeat(32)}i0`, ITEMS[2]!.id];
    const { site } = renderSite('/club', { mintServices: mint });
    // holdings for whatever ordinals address the fake wallet has
    const w = await mint.wallets.connect('unisat', 'mainnet');
    site.ord.getAddressInscriptions = async (addr) => (addr === w.ordinals.address ? held : []);
    signed.length = 0;

    await userEvent.click(screen.getByRole('button', { name: 'Sign in with UniSat' }));
    const me = await screen.findByTestId('signed-in');
    expect(me).toHaveTextContent('BIP-322');
    expect(signed).toHaveLength(1);
    expect(signed[0]!.type).toBe('bip322-simple');
    expect(signed[0]!.address).toBe(w.ordinals.address);
    expect(signed[0]!.message).toContain('wants you to sign in with your Bitcoin account:');
    expect(signed[0]!.message).toContain(SIWB_STATEMENT);
    expect(signed[0]!.message).toMatch(/\nNonce: [0-9a-f]{32}\n/);

    const owned = await screen.findByTestId('owned');
    const links = within(owned).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual(['Degent #3', 'Degent #7']);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('button', { name: 'Sign in with UniSat' })).toBeInTheDocument();
  });

  it('Horizon signs ECDSA with its payment address', async () => {
    const { mint, signed } = spyWallets(['horizon']);
    renderSite('/club', { mintServices: mint });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Horizon Wallet' }));
    expect(await screen.findByTestId('signed-in')).toHaveTextContent('ECDSA / BIP-137');
    expect(signed[0]!.type).toBe('ecdsa');
    expect(signed[0]!.address).toMatch(/^bc1q/);
  });

  it('a rejected signature shows an error and stays signed out', async () => {
    renderSite('/club', { mint: { wallet: { installed: ['unisat'], rejectSign: true } } });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with UniSat' }));
    expect(await screen.findByText('Sign-in failed')).toBeInTheDocument();
    expect(screen.queryByTestId('signed-in')).toBeNull();
  });

  it('no holdings → honest empty state', async () => {
    const { mint } = spyWallets(['xverse']);
    const { site } = renderSite('/club', { mintServices: mint });
    site.ord.getAddressInscriptions = async () => [];
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Xverse' }));
    expect(await screen.findByText('No Degents in this address yet')).toBeInTheDocument();
  });
});
