import { useMint } from '../flow/context';
import { ResumeBanner } from '../components/ResumeBanner';
import { Button, Money, Panel } from '../components/ui';
import { formatEta, formatFeeRate, formatSize } from '../lib/format';
import { tierRule } from '../lib/rules';

export function Welcome() {
  const { state, dispatch } = useMint();
  const { config, fees, queue } = state;
  const std = config ? tierRule(config, 'standard') : null;
  const lrg = config ? tierRule(config, 'large') : null;
  const blk = config ? tierRule(config, 'fullblock') : null;
  const blockRate = fees?.blockRecommended ?? fees?.economy ?? 2;
  // Illustration only (witness bytes weigh 1 WU → ~bytes/4 vB). The binding quote comes from @bsh/inscription.
  const blockFeeExample = blk ? Math.ceil((blk.maxBytes / 4) * blockRate) : null;

  return (
    <div className="screen screen--welcome">
      <ResumeBanner />
      <section className="hero">
        <p className="kicker">Members’ entrance</p>
        <h1 tabIndex={-1} className="hero__title">
          Mint a Degent.
          <span className="hero__sub">Bitcoin’s most iconic on-chain collection, by the gentlemen who inscribe it.</span>
        </h1>
        <p className="lede">
          A Degent is a frog of impeccable taste — Pepe in a tuxedo, bowtie mandatory — inscribed directly on Bitcoin and
          linked to the club’s parent inscription, so any ord indexer can verify membership. No hand-kept list. No
          custodian. <strong>What you preview here is byte-for-byte what lands on chain.</strong>
        </p>
        <div className="row">
          <Button onClick={() => dispatch({ type: 'GO', step: 'connect' })} disabled={!config}>
            Start minting
          </Button>
          {!config && !state.error ? <span className="muted small" role="status">Fetching the house rules…</span> : null}
        </div>
      </section>

      <div className="tiers">
        <article className="tier">
          <p className="kicker">Tier I</p>
          <h2 className="tier__name">Standard Degent</h2>
          <p className="tier__size mono">{std ? `${formatSize(std.minBytes)} – ${formatSize(std.maxBytes)}` : '200.0 kB – 400.0 kB'}</p>
          <ul className="ticks">
            <li>Usually relays through the normal mempool, many per block</li>
            <li>The top few kB of the range weigh over 400,000 WU and take the block lane — the quote says so</li>
            <li>Lowest cost; the everyday gentleman</li>
          </ul>
        </article>
        <article className="tier tier--large">
          <p className="kicker">Tier II</p>
          <h2 className="tier__name">Large Degent</h2>
          <p className="tier__size mono">{lrg ? `${formatSize(lrg.minBytes)} – ${formatSize(lrg.maxBytes)}` : '400.0 kB – 3.50 MB'}</p>
          <ul className="ticks">
            <li>Non-standard relay via Libre Relay / Slipstream</li>
            <li>
              <strong>Shares a block</strong> with other Large Degents when their weights fit the 3,990,000 WU budget
            </li>
            <li>Queue position is a block slot; ETA is slot × ~10 min, not a promise</li>
          </ul>
        </article>
        <article className="tier tier--block">
          <p className="kicker">Tier III · the 4 MB Degent</p>
          <h2 className="tier__name">Full Block Degent</h2>
          <p className="tier__size mono">{blk ? `${formatSize(blk.minBytes)} – ${formatSize(blk.maxBytes)}` : '3.50 MB – 3.90 MB'}</p>
          <ul className="ticks">
            <li>Fills a Bitcoin block on its own</li>
            <li>
              <strong>Always alone</strong> — one per block slot, never shared
            </li>
            <li>Non-standard relay via Libre Relay / Slipstream</li>
          </ul>
          {blockFeeExample !== null ? (
            <p className="tier__cost">
              A full-size Full Block Degent at {formatFeeRate(blockRate)} is roughly <Money sats={blockFeeExample} /> in network
              fees alone.
            </p>
          ) : null}
        </article>
      </div>

      <Panel kicker="Right now" title="Fees & the queue">
        <div className="snapshot" aria-live="polite">
          <dl className="snapshot__group">
            <div>
              <dt>Economy</dt>
              <dd className="mono">{fees ? formatFeeRate(fees.economy) : '…'}</dd>
            </div>
            <div>
              <dt>Normal</dt>
              <dd className="mono">{fees ? formatFeeRate(fees.normal) : '…'}</dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd className="mono">{fees ? formatFeeRate(fees.priority) : '…'}</dd>
            </div>
          </dl>
          <dl className="snapshot__group">
            <div>
              <dt>Block lane</dt>
              <dd className="mono">{queue ? `${queue.blockLaneLength} waiting` : '…'}</dd>
            </div>
            <div>
              <dt>Next Block Degent slot</dt>
              <dd className="mono">{queue ? formatEta(queue.blockLaneEtaMinutes) : '…'}</dd>
            </div>
            <div>
              <dt>Standard lane</dt>
              <dd className="mono">{queue ? `${queue.standardLaneLength} queued` : '…'}</dd>
            </div>
          </dl>
        </div>
      </Panel>

      <Panel kicker="How it works" title="Seven steps, no custodian">
        <ol className="howto">
          <li>
            <strong>Connect</strong> any Bitcoin wallet.
          </li>
          <li>
            <strong>Create</strong> your art and compress it to the tier’s byte range — right here in the browser.
          </li>
          <li>
            <strong>Validate</strong>: the collection rules run locally, then the automated doorman reviews the art. Nothing
            is payable until it is approved.
          </li>
          <li>
            <strong>Quote</strong>: an exact fee breakdown, and the commit address recomputed in your browser.
          </li>
          <li>
            <strong>Pay</strong> in one wallet signature. The reveal is pre-signed by a one-time key that never leaves your
            hands: it goes into your recovery bundle, not to us.
          </li>
          <li>
            <strong>Track</strong> it to the block, then compare the on-chain bytes to your preview.
          </li>
          <li>
            <strong>Rescue</strong> it yourself, with that key, if the service ever fails to deliver.
          </li>
        </ol>
      </Panel>
    </div>
  );
}
