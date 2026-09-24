import { useMint } from '../flow/context';
import { ResumeBanner } from '../components/ResumeBanner';
import { Button, Money, Panel } from '../components/ui';
import { formatEta, formatFeeRate, formatSize } from '../lib/format';

export function Welcome() {
  const { state, dispatch } = useMint();
  const { config, fees, queue } = state;
  const std = config?.tiers.find((t) => t.tier === 'standard') ?? null;
  // A service without a block-lane broadcaster (mainnet soft launch) does not offer the block tier at all.
  const blk = config?.tiers.find((t) => t.tier === 'block') ?? null;
  const blockOffered = !config || blk !== null;
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
          <p className="tier__size mono">{std ? `${formatSize(std.minBytes)} – ${formatSize(std.maxBytes)}` : '200 – 390 kB'}</p>
          <ul className="ticks">
            <li>Relays through the normal mempool</li>
            <li>Many per block — usually in the next few blocks</li>
            <li>Lowest cost; the everyday gentleman</li>
          </ul>
        </article>
        {blockOffered ? (
        <article className="tier tier--block">
          <p className="kicker">Tier II · the 4 MB Degent</p>
          <h2 className="tier__name">Block Degent</h2>
          <p className="tier__size mono">{blk ? `up to ${formatSize(blk.maxBytes)}` : 'up to ~3.9 MB'}</p>
          <ul className="ticks">
            <li>Fills (almost) an entire Bitcoin block</li>
            <li>
              <strong>One per block</strong> — you join a queue; ETA is position × ~10 min, not a promise
            </li>
            <li>Non-standard relay via Libre Relay / Slipstream</li>
          </ul>
          {blockFeeExample !== null ? (
            <p className="tier__cost">
              A full-size Block Degent at {formatFeeRate(blockRate)} is roughly <Money sats={blockFeeExample} /> in network
              fees alone.
            </p>
          ) : null}
        </article>
        ) : null}
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
            <strong>Pay</strong> in one wallet signature. The reveal is pre-signed by a one-time key that never leaves this
            tab.
          </li>
          <li>
            <strong>Track</strong> it to the block, then compare the on-chain bytes to your preview.
          </li>
          <li>
            <strong>Rescue</strong> it yourself if the service ever fails to deliver.
          </li>
        </ol>
      </Panel>
    </div>
  );
}
