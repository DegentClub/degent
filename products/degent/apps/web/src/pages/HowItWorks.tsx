/**
 * `/how-it-works` ("Minting Process" / "Learn How"): the Minting Rules, the tiers and live fees (worked
 * examples from @bsh/inscription, not rules of thumb), the wallets, Design → Mint → Confirm → Approve, what
 * the members' review means, self-rescue with the recovery passphrase, and what the recovery bundle is.
 */
import { DEFAULT_CONFIG, type ServiceConfig } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { MINTING_RULES } from '../atelier/mintingRules';
import { STAGES, STAGE_COPY } from '../lib/timeline';
import { estimateReveal } from '../lib/revealEstimate';
import { formatFeeRate, formatSize } from '../lib/format';
import { ExternalLink, Money } from '../components/ui';
import { CtaLink, useDocumentMeta } from '../site/components';

function Example({ bytes, feeRate, label }: { bytes: number; feeRate: number; label: string }) {
  const { state, app } = useMint();
  const config = (state.config ?? DEFAULT_CONFIG) as ServiceConfig;
  let fee: number | null = null;
  let vsize: number | null = null;
  try {
    const e = estimateReveal({
      contentType: 'image/jpeg',
      bodyLength: bytes,
      parentId: config.parentInscriptionId,
      network: app.network,
      collectionAddress: config.collectionAddress ?? null,
      feeRate,
      postageSats: config.postageSats,
    });
    fee = e.feeSats;
    vsize = e.vsize;
  } catch {
    /* config not loaded */
  }
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="mono">{formatSize(bytes)}</td>
      <td className="mono">{vsize !== null ? `${vsize.toLocaleString('en-US')} vB` : '—'}</td>
      <td className="mono">{formatFeeRate(feeRate)}</td>
      <td>{fee !== null ? <Money sats={fee} /> : '—'}</td>
    </tr>
  );
}

export function HowItWorks() {
  const { state, services } = useMint();
  const config = state.config ?? DEFAULT_CONFIG;
  const fees = state.fees;
  const wallets = services.wallets.list();
  useDocumentMeta({ title: 'Minting Process · degent.club', description: 'The essential requirements for minting a Degent and joining the club.' });
  const std = config.tiers.find((t) => t.tier === 'standard');
  const blk = config.tiers.find((t) => t.tier === 'block');

  return (
    <div className="page">
      <div className="page-head">
        <p className="badge-pill">Learn how</p>
        <h1 tabIndex={-1}>Minting Process</h1>
        <p className="lede">The essential requirements for minting a Degent and joining the club.</p>
      </div>

      <section aria-labelledby="rules-title">
        <h2 id="rules-title">Minting Rules</h2>
        <ul className="rule-cards">
          {MINTING_RULES.map((r, i) => (
            <li key={r.id} className="card rule-card">
              <span className="rule-card__check" aria-hidden="true">
                ✓
              </span>
              <h3>
                {i + 1}. {r.title}
              </h3>
              <p>{r.rule}</p>
            </li>
          ))}
        </ul>
        <p className="small muted">
          JPEG is the recommended format; PNG, WebP, AVIF and GIF are accepted too. The Atelier in the mint crops your picture
          square, frames it in gold with the placard and fits the file to your tier.
        </p>
        <aside className="callout" aria-labelledby="dyk-title">
          <h3 id="dyk-title">Did you know?</h3>
          <p>All approved Degents become part of the official Decentralized Gentlemen Club collection and are eligible for member-only benefits.</p>
        </aside>
      </section>

      <section aria-labelledby="tiers-title">
        <h2 id="tiers-title">Tiers and fees</h2>
        <div className="tiers">
          {config.tiers.map((t) => (
            <article key={t.tier} className={`tier ${t.tier === 'block' ? 'tier--block' : ''}`}>
              <h3 className="tier__name">{t.label}</h3>
              <p className="tier__size mono">
                {formatSize(t.minBytes)} – {formatSize(t.maxBytes)}
              </p>
              <p>{t.description}</p>
              <p className="small">
                Service fee: {config.serviceFeeSats[t.tier] > 0 ? <Money sats={config.serviceFeeSats[t.tier]} /> : 'none'} · postage{' '}
                <span className="mono">{config.postageSats} sats</span>
              </p>
            </article>
          ))}
        </div>
        <p>
          You pay the network fee for the reveal transaction that carries your art, plus the postage that travels with the
          inscription (and a service fee if the club sets one). The fee depends on the size of the file and the fee rate
          right now; the quote you get before paying is exact and binding.
        </p>
        <table className="bill" aria-label="Worked examples at today's fee rates">
          <thead>
            <tr>
              <th scope="col">Example</th>
              <th scope="col">File</th>
              <th scope="col">Reveal</th>
              <th scope="col">Rate</th>
              <th scope="col">Network fee</th>
            </tr>
          </thead>
          <tbody>
            {std ? <Example label="Standard Degent" bytes={300_000} feeRate={fees?.normal ?? config.minFeeRate} /> : null}
            {blk ? <Example label="Block Degent" bytes={2_000_000} feeRate={fees?.blockRecommended ?? fees?.economy ?? config.minFeeRate} /> : null}
          </tbody>
        </table>
        <p className="small muted">{fees ? `Live rates from the mint: economy ${formatFeeRate(fees.economy)}, normal ${formatFeeRate(fees.normal)}, priority ${formatFeeRate(fees.priority)}.` : 'Fetching live fee rates…'}</p>
      </section>

      <section aria-labelledby="wallets-title">
        <h2 id="wallets-title">Wallets</h2>
        <p>
          Any of these Bitcoin wallets can mint. You need a taproot (ordinals) address to receive the Degent and a payment
          address to fund it; the wallet signs, the mint never holds your keys.
        </p>
        <ul className="wallet-list">
          {wallets.map((w) => (
            <li key={w.id}>
              <strong>{w.name}</strong> · <ExternalLink href={w.installUrl}>install</ExternalLink>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="stages-title">
        <h2 id="stages-title">Design → Mint → Confirm → Approve</h2>
        <ol className="stage-cards">
          {STAGES.map((s, i) => (
            <li key={s} className="card">
              <span className="stage__num" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{STAGE_COPY[s].label}</h3>
              <p>{STAGE_COPY[s].blurb}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="after-title">
        <h2 id="after-title">What happens after you pay</h2>
        <h3>The members’ review</h3>
        <p>
          Once your funding transaction is mined, existing club members look at your Degent and vote by signing a message with
          the wallet that holds theirs. Every vote is a public BIP-322 signature anyone can check. When enough members approve,
          your Degent gets its number and the club co-signs the parent link at reveal: approval is membership.
        </p>
        <h3>If the members decline, or the mint stalls: self-rescue</h3>
        <p>
          Your funds are never stranded. The funding you paid sits in a commit output that only your one-time reveal key can
          spend, and that key is kept in your recovery bundle, encrypted with the recovery passphrase you chose. On the Track
          page, enter the passphrase: your browser decrypts the key and signs a reveal straight to your ordinals address. The
          inscription lands; without the parent link it is simply not a Degent.
        </p>
        <h3>The recovery bundle</h3>
        <p>
          Before your wallet is asked to sign, the mint saves a small JSON file in this browser and shows it for you to copy:
          the order id, the funding outpoint and amounts, your recipient address, the SHA-256 of your art, the one-time key
          encrypted with your passphrase (AES-256-GCM, PBKDF2), and the order’s private token. Keep a copy somewhere private,
          and never store the passphrase next to it: together they can spend the commit.
        </p>
        <p>
          Want updates? On the Track page, “Notify me” sends an email or Telegram message when your Degent is with the club,
          if the members decline it, if self-rescue opens, and when it joins the club.
        </p>
      </section>

      <div className="row">
        <CtaLink to="/mint">Mint Now</CtaLink>
        <CtaLink to="/collection" variant="dark">
          See the collection
        </CtaLink>
      </div>
    </div>
  );
}
