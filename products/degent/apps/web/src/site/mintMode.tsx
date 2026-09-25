/**
 * Read-only mint mode (docs/SERVER.md): while the mint API reports `mode: "readonly"` in `/v1/config` (or, until it
 * answers, the build hint VITE_MINT_MODE), every Mint call to action says "Minting opens soon" and points at the
 * signet beta (VITE_BETA_URL), `/mint` explains instead of running the wizard, and `/review` explains that the
 * members' review opens with minting. The runtime answer always wins, so one build serves both modes.
 *
 * Test networks get a persistent banner: signet/testnet coins have no value.
 */
import type { ReactNode } from 'react';
import type { Network } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { Panel } from '../components/ui';
import { CtaLink, SiteLink } from './components';

export interface MintModeView {
  readonly: boolean;
  betaUrl: string;
}

export function useMintMode(): MintModeView {
  const { state, app } = useMint();
  const mode = state.mintMode ?? app.mintMode;
  return { readonly: mode === 'readonly', betaUrl: app.betaUrl };
}

export const MINTING_OPENS_SOON = 'Minting opens soon';

/**
 * The one Mint call to action. Full mode: an internal link to /mint with the given label. Read-only: "Minting opens
 * soon", linking to the signet beta when configured (new tab), else to the /mint explainer.
 */
export function MintCta({ children, variant = 'primary', className }: { children: ReactNode; variant?: 'primary' | 'dark'; className?: string }) {
  const { readonly, betaUrl } = useMintMode();
  const cls = className ?? `btn btn--${variant === 'primary' ? 'primary' : 'dark'}`;
  if (!readonly) return className ? <SiteLink to="/mint" className={className}>{children}</SiteLink> : <CtaLink to="/mint" variant={variant}>{children}</CtaLink>;
  if (betaUrl)
    return (
      <a href={betaUrl} className={cls} target="_blank" rel="noopener noreferrer" data-testid="mint-cta">
        {MINTING_OPENS_SOON}
        <span className="sr-only"> (try the signet beta, opens in a new tab)</span>
      </a>
    );
  return (
    <SiteLink to="/mint" className={cls}>
      {MINTING_OPENS_SOON}
    </SiteLink>
  );
}

/** `/mint` while the mint is read-only. */
export function MintingOpensSoon() {
  const { betaUrl } = useMintMode();
  return (
    <div className="page" data-testid="mint-closed">
      <div className="page-head">
        <p className="badge-pill">The mint</p>
        <h1 tabIndex={-1}>{MINTING_OPENS_SOON}</h1>
        <p className="lede">
          The Decentralized Gentlemen Club is getting ready to open the mint on Bitcoin. Until then the site is read-only: the
          Collection, the Register, the comic and the club’s holdings are all live.
        </p>
      </div>
      <Panel title="Try it first on signet" kicker="Public beta">
        <p>
          The full mint runs on Bitcoin’s public test network (signet): design your Degent in the Atelier, pay with test coins
          from a faucet, and follow it through the members’ review. Signet coins have no value, so nothing is at stake.
        </p>
        {betaUrl ? (
          <a href={betaUrl} className="btn btn--primary" target="_blank" rel="noopener noreferrer">
            Open the signet beta<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </Panel>
      <Panel title="How minting will work" kicker="Design → Mint → Confirm → Approve">
        <p>
          Read the rules, the tiers and how self-rescue protects your coins before the mint opens.{' '}
          <SiteLink to="/how-it-works">How it works</SiteLink>
        </p>
      </Panel>
    </div>
  );
}

/** `/review` while the mint is read-only. */
export function ReviewOpensWithMinting() {
  const { betaUrl } = useMintMode();
  return (
    <div className="page" data-testid="review-closed">
      <div className="page-head">
        <p className="badge-pill">Members decide</p>
        <h1 tabIndex={-1}>Membership review opens with minting</h1>
        <p className="lede">
          Every new Degent joins by the members’ vote. There is nothing to review until the mint opens; holders will sign in
          here with the wallet that holds their Degent.
        </p>
      </div>
      <Panel title="Meanwhile">
        <p>
          See who is in the club in the <SiteLink to="/explorer">Register</SiteLink>
          {betaUrl ? (
            <>
              , or try the whole flow, review included, on the{' '}
              <a href={betaUrl} target="_blank" rel="noopener noreferrer">
                signet beta<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          ) : null}
          .
        </p>
      </Panel>
    </div>
  );
}

export function isTestNetwork(network: Network): boolean {
  return network === 'signet' || network === 'testnet';
}

/** Persistent banner on test-network builds. */
export function TestNetworkBanner({ network }: { network: Network }) {
  if (!isTestNetwork(network)) return null;
  return (
    <div className="testnet-banner" role="note" data-testid="testnet-banner">
      <strong>Test network:</strong> {network} coins have no value. This is the {network} beta of degent.club; Degents minted here
      are not the collection.
    </div>
  );
}
