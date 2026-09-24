import { DEFAULT_CONFIG } from '@bsh/degent-mint-sdk';
import { useAsync, useSite } from '../context';
import { useDocumentMeta } from '../lib/meta';
import { STATUS_COPY } from '../../lib/timeline';
import { formatSatsShort, indicativeRevealSats } from '../lib/cost';
import { Icon } from '../components/Icons';
import { Cta, SectionTitle } from '../components/ui';

/** The four Minting Rules, verbatim from the live site. */
export const MINTING_RULES = [
  { title: 'File Format & Size', text: 'Square JPEG format with a minimum size of 200KB.' },
  { title: 'Essential Design', text: 'Pepe character wearing a tuxedo with a mandatory bowtie.' },
  { title: 'Framing & Text', text: 'Must be framed and include a placard that says “DEGEN”, “DEGENT”, or “REGEN”.' },
  { title: 'Quantity', text: 'Mint as many as you want – create your own mini-collection!' },
] as const;

const AFTER_PAY = ['paid', 'queued', 'revealing', 'revealed', 'confirmed', 'verified', 'delivered'] as const;

const kb = (b: number) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(b % 1_000_000 ? 1 : 0)} MB` : `${Math.round(b / 1000)} KB`);

export function TierTable({ feeRate }: { feeRate: number | null }) {
  return (
    <div className="table-wrap">
      <table className="tiers-table" data-testid="tiers-table">
        <caption className="sr-only">Degent tiers by content bytes</caption>
        <thead>
          <tr>
            <th scope="col">Tier</th>
            <th scope="col">Content bytes</th>
            <th scope="col">Lane</th>
            <th scope="col">Reveal cost{feeRate ? ` at ${feeRate} sat/vB` : ''}</th>
          </tr>
        </thead>
        <tbody>
          {DEFAULT_CONFIG.tiers.map((t) => (
            <tr key={t.tier}>
              <th scope="row">{t.label}</th>
              <td className="mono">
                {kb(t.minBytes)}–{kb(t.maxBytes)}
              </td>
              <td>
                {t.tier === 'standard'
                  ? 'Standard lane (≤ 400,000 WU); the last few KB travel the block lane'
                  : t.sharesBlock
                    ? 'Block lane, shares a block with other Large Degents'
                    : 'Block lane, a whole block to itself'}
              </td>
              <td className="mono">
                {feeRate ? `≈ ${formatSatsShort(indicativeRevealSats(t.minBytes, feeRate))} – ${formatSatsShort(indicativeRevealSats(t.maxBytes, feeRate))}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Costs are indicative (≈ bytes ÷ 4 vbytes × fee rate). The mint quotes the exact figure from your exact bytes before you pay, and
        adds postage (546 sats) and your wallet's funding fee.
      </p>
    </div>
  );
}

export function RulesCards({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={`rules ${compact ? 'rules--compact' : ''}`} data-testid="rules-cards">
      {MINTING_RULES.map((r) => (
        <li key={r.title} className="rule-card">
          <span className="rule-card__check" aria-hidden="true">
            <Icon.check />
          </span>
          <h3>{r.title}</h3>
          <p>{r.text}</p>
        </li>
      ))}
    </ul>
  );
}

export function HowItWorks() {
  const { mint } = useSite();
  useDocumentMeta({ title: 'Minting Process', description: 'Minting Rules, tiers, lanes, wallets and what happens after you pay.' });
  const fees = useAsync(() => mint.mintApi.getFees(), [mint]);
  const wallets = mint.wallets.list();
  return (
    <div className="container stack page-top">
      <SectionTitle level={1} kicker="Mint Process" title="Minting Rules" sub="The essential requirements for minting a Degent and joining the club." />
      <RulesCards />
      <aside className="didyouknow" aria-labelledby="dyk-h">
        <h2 id="dyk-h">Did you know?</h2>
        <p>All approved Degents become part of the official Decentralized Gentlemen Club collection and are eligible for member-only benefits.</p>
      </aside>
      <p className="small muted">
        JPEG is the recommended format; the mint also accepts PNG, WebP, AVIF and GIF. The automated review checks the frame and the placard.
        There is no per-wallet cap.
      </p>

      <section aria-labelledby="tiers-h">
        <SectionTitle title="Three tiers, two lanes" id="tiers-h" sub="Tiers are by content bytes. Lanes are by the reveal's exact weight, measured from your bytes: never assumed from the tier." />
        <TierTable feeRate={fees.status === 'ok' ? fees.value.normal : null} />
      </section>

      <section aria-labelledby="wallets-h">
        <SectionTitle title="Wallets" id="wallets-h" sub="Any of these can pay. You sign exactly once: the funding transaction." />
        <ul className="wallet-pills">
          {wallets.map((w) => (
            <li key={w.id}>{w.name}</li>
          ))}
        </ul>
        <p className="small muted">Your Degent is delivered to your wallet's ordinals (Taproot) address; you pay from its payment address (SegWit or Taproot; legacy addresses cannot fund the mint).</p>
      </section>

      <section aria-labelledby="after-h">
        <SectionTitle title="What happens after you pay" id="after-h" />
        <ol className="after-pay" data-testid="after-pay">
          {AFTER_PAY.map((s, i) => (
            <li key={s}>
              <span className="after-pay__n" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3>{STATUS_COPY[s].label}</h3>
                <p>{STATUS_COPY[s].blurb}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="small">
          Before your wallet signs, the page saves a <strong>recovery bundle</strong> with a one-time reveal key. If the service ever fails to reveal
          in time, you can reveal it yourself with that bundle: the mint is non-custodial.
        </p>
      </section>
      <div className="cta-row">
        <Cta to="/mint" icon={<Icon.rocket />}>
          Mint Now!
        </Cta>
        <Cta to="/atelier" variant="dark" icon={<Icon.brush />}>
          Make one in the Atelier
        </Cta>
      </div>
    </div>
  );
}
