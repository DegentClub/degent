import { useEffect, useState } from 'react';
import type { Order } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { rescue } from '../flow/effects';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, CopyBlock, ExternalLink, Money, Mono, Panel, errorText, useObjectUrl } from '../components/ui';
import { orderArtworkId, orderEdition, royaltyPaidOf } from '../services/types';
import { buildTimeline, isTerminal, STATUS_COPY } from '../lib/timeline';
import { clearRecovery, parseRecovery, recoveryJson } from '../lib/recovery';
import { formatTimestamp, shortHash } from '../lib/format';

type HashCheck = { state: 'idle' | 'checking' } | { state: 'match' | 'mismatch'; onChain: string } | { state: 'error'; message: string };

export function Timeline({ order, explorerUrl }: { order: Pick<Order, 'status' | 'timeline'>; explorerUrl: string }) {
  const steps = buildTimeline(order);
  return (
    <ol className="timeline" aria-label="Order timeline">
      {steps.map((s) => (
        <li
          key={s.status}
          className={`timeline__step timeline__step--${s.state}`}
          aria-current={s.state === 'current' || s.state === 'problem' ? 'step' : undefined}
          data-testid={`step-${s.status}`}
          data-state={s.state}
        >
          <span className="timeline__dot" aria-hidden="true" />
          <div className="timeline__body">
            <p className="timeline__label">
              {s.label}
              <span className="sr-only"> — {s.state === 'done' ? 'done' : s.state === 'current' ? 'in progress' : s.state === 'problem' ? 'needs attention' : 'not yet'}</span>
            </p>
            {s.state !== 'upcoming' ? <p className="timeline__blurb">{s.event?.detail ?? s.blurb}</p> : null}
            {s.event ? <p className="timeline__at mono">{formatTimestamp(s.event.at)}</p> : null}
            {s.event?.txid ? (
              <p className="small">
                <ExternalLink href={`${explorerUrl}/tx/${s.event.txid}`}>tx {shortHash(s.event.txid)}</ExternalLink>
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Track() {
  const { state, dispatch, services, app, store, vault } = useMint();
  const orderId = state.order?.id ?? state.recovery?.orderId ?? null;
  const [order, setOrder] = useState<Order | null>(state.order);
  const [pollError, setPollError] = useState<string | null>(null);
  const [hash, setHash] = useState<HashCheck>({ state: 'idle' });
  const [rescueState, setRescueState] = useState<
    { state: 'idle' | 'busy' } | { state: 'done'; txid: string; source: 'service' | 'local' } | { state: 'error'; message: string }
  >({ state: 'idle' });
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  // Poll the order until it reaches a terminal state.
  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const o = await services.mintApi.getOrder(orderId);
        if (!alive) return;
        setOrder(o);
        setPollError(null);
        if (isTerminal(o.status)) return;
      } catch (e) {
        if (!alive) return;
        setPollError(errorText(e));
      }
      timer = setTimeout(() => void tick(), app.pollIntervalMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, services, app.pollIntervalMs]);

  // Once verified, hash the on-chain bytes ourselves.
  const inscriptionId = order?.inscriptionId ?? null;
  const verifiedish = order?.status === 'verified' || order?.status === 'delivered';
  useEffect(() => {
    if (!verifiedish || !inscriptionId || !order) return;
    let alive = true;
    setHash({ state: 'checking' });
    services.chain
      .getInscriptionContent(inscriptionId)
      .then((bytes) => {
        if (!alive) return;
        const onChain = services.inscription.sha256Hex(bytes);
        setHash({ state: onChain === order.contentSha256 ? 'match' : 'mismatch', onChain });
      })
      .catch((e) => alive && setHash({ state: 'error', message: errorText(e) }));
    return () => {
      alive = false;
    };
    // Only re-run when the inscription or verification state changes.
  }, [inscriptionId, verifiedish, services]);

  const localBytes = state.artwork && order && state.artwork.sha256 === order.contentSha256 ? state.artwork : null;
  const localUrl = useObjectUrl(localBytes?.bytes ?? null, localBytes?.contentType ?? 'application/octet-stream');

  const doRescue = async () => {
    if (!orderId) return;
    setRescueState({ state: 'busy' });
    try {
      const r = await rescue(
        { services },
        {
          orderId,
          orderToken: vault.token(orderId),
          bundle: state.recovery,
          wallet: state.wallet,
          network: app.network,
          artwork: state.artwork,
        },
      );
      setRescueState({ state: 'done', txid: r.txid, source: r.source });
    } catch (e) {
      setRescueState({ state: 'error', message: errorText(e) });
    }
  };

  const commitTxid = order?.commitOutpoint?.txid ?? state.recovery?.commitTxid ?? state.pay.commitTxid;
  const royaltyPaid = royaltyPaidOf(order);
  const artworkId = orderArtworkId(order) ?? state.recovery?.artworkId ?? null;
  const edition = orderEdition(order) ?? state.recovery?.edition ?? null;

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 7 of 7"
        title="From mempool to membership."
        lede="This page follows your order on its own. You can close it — reopen the site on this device to resume."
      />

      <Panel title="Status">
        <div aria-live="polite" className="status-now">
          {order ? (
            <p>
              <Badge tone={order.status === 'delivered' || order.status === 'verified' ? 'good' : order.status === 'rescue_available' || order.status === 'failed' || order.status === 'rejected' || order.status === 'expired' ? 'bad' : 'brass'}>
                {STATUS_COPY[order.status].label}
              </Badge>{' '}
              {STATUS_COPY[order.status].blurb}
            </p>
          ) : (
            <p className="muted">Fetching order {orderId ? <Mono>{orderId}</Mono> : null}…</p>
          )}
        </div>
        {pollError ? (
          <Alert tone="warn" title="Could not reach the mint just now">
            {pollError}. Retrying. Your Degent does not depend on this page — and your recovery bundle works without the mint.
          </Alert>
        ) : null}
        <p className="small">
          Order <Mono>{orderId ?? '—'}</Mono>
          {commitTxid ? (
            <>
              {' '}
              · funding <ExternalLink href={`${app.explorerUrl}/tx/${commitTxid}`}>{shortHash(commitTxid)}</ExternalLink>
            </>
          ) : null}
          {order?.revealTxid ? (
            <>
              {' '}
              · reveal <ExternalLink href={`${app.explorerUrl}/tx/${order.revealTxid}`}>{shortHash(order.revealTxid)}</ExternalLink>
            </>
          ) : null}
        </p>
        {artworkId ? (
          <p className="small" data-testid="studio-order">
            Studio Degent <Mono>{artworkId}</Mono>
            {edition !== null ? <> · edition <span className="mono">#{edition}</span></> : null}
          </p>
        ) : null}
        {royaltyPaid ? (
          <p className="small" data-testid="artist-paid">
            <Badge tone="good">Artist paid</Badge> <Money sats={royaltyPaid.sats} /> in{' '}
            <ExternalLink href={`${app.explorerUrl}/tx/${royaltyPaid.txid}`}>
              {shortHash(royaltyPaid.txid, 6)}:{royaltyPaid.vout}
            </ExternalLink>
          </p>
        ) : null}
        {order?.queue && order.queue.position !== null ? (
          <p className="small">
            {order.queue.lane === 'block' ? (
              <>
                Block lane: block slot <span className="mono">{order.queue.position}</span> (shared by weight, a Full Block Degent
                alone) · ETA <span className="mono">~{order.queue.etaMinutes ?? '?'} min</span>
              </>
            ) : (
              <>
                Standard lane: position <span className="mono">{order.queue.position}</span> · ETA{' '}
                <span className="mono">~{order.queue.etaMinutes ?? '?'} min</span>
              </>
            )}
          </p>
        ) : null}
        {order ? <Timeline order={order} explorerUrl={app.explorerUrl} /> : null}
      </Panel>

      {order?.status === 'rescue_available' ? (
        <Panel title="Rescue your Degent" kicker="Self-custody, as promised">
          <p>
            The mint has not revealed your Degent in time. Your reveal was signed with{' '}
            <Mono>SIGHASH_ALL | ANYONECANPAY</Mono>, which pins every output (that is what stops anyone redirecting it), so
            a rescue is a <em>fresh</em> one-input, one-output transaction — <em>commit → your ordinals address</em> — signed
            right here with the one-time key from your recovery bundle. The mint only supplies the order facts and cannot
            sign anything. Broadcasting it lands the inscription now, without the on-chain parent link to the collection.
            Your sats and your art are never stranded.
          </p>
          {!state.recovery ? (
            <div className="field">
              <label htmlFor="paste-bundle" className="label">
                No recovery bundle on this device — paste the one you saved when you paid
              </label>
              <textarea
                id="paste-bundle"
                className="copyblock__text mono"
                rows={6}
                value={pasted}
                onChange={(e) => setPasted(e.currentTarget.value)}
                spellCheck={false}
              />
              <div className="row">
                <Button
                  variant="secondary"
                  onClick={() => {
                    const b = parseRecovery(pasted);
                    if (!b) return setPasteError('That is not a degent.club recovery bundle (version 2).');
                    if (b.orderId !== orderId) return setPasteError(`That bundle is for order ${b.orderId}, not ${orderId}.`);
                    setPasteError(null);
                    dispatch({ type: 'RESUME', bundle: b });
                  }}
                >
                  Use this bundle
                </Button>
                {pasteError ? <span role="alert" className="small">{pasteError}</span> : null}
              </div>
            </div>
          ) : null}
          <div className="actions">
            <Button
              variant="danger"
              busy={rescueState.state === 'busy'}
              disabled={rescueState.state === 'done' || !state.recovery}
              onClick={() => void doRescue()}
            >
              Rescue now (reveal without parent)
            </Button>
          </div>
          <div aria-live="assertive">
            {rescueState.state === 'done' ? (
              <Alert tone="good" title="Rescue broadcast">
                Reveal tx <ExternalLink href={`${app.explorerUrl}/tx/${rescueState.txid}`}>{rescueState.txid}</ExternalLink>
                {rescueState.source === 'local'
                  ? ' — signed in your browser from the recovery bundle alone (the mint was unreachable).'
                  : ' — signed in your browser with your key; the mint supplied the order facts and they matched your bundle.'}
              </Alert>
            ) : null}
            {rescueState.state === 'error' ? <Alert tone="bad" title="Rescue failed">{rescueState.message}</Alert> : null}
          </div>
        </Panel>
      ) : null}

      {verifiedish && inscriptionId ? (
        <Panel title="Welcome to the club." kicker={order?.rescued ? 'Delivered via rescue (no parent link)' : 'Verified on chain'}>
          <p>
            Inscription <Mono wrap>{inscriptionId}</Mono>
          </p>
          <div className="compare">
            {localUrl ? (
              <figure>
                <img src={localUrl} alt="Your local preview" />
                <figcaption className="small muted">Your preview (local bytes)</figcaption>
              </figure>
            ) : null}
            <figure>
              <img src={services.chain.contentUrl(inscriptionId)} alt="The inscription as rendered from the chain" />
              <figcaption className="small muted">On chain (ord /content)</figcaption>
            </figure>
          </div>
          <p aria-live="polite" className="hashline">
            {hash.state === 'checking' ? 'Hashing the on-chain bytes…' : null}
            {hash.state === 'match' ? (
              <>
                <Badge tone="good">hash match ✓</Badge> <Mono wrap>{order!.contentSha256}</Mono>
              </>
            ) : null}
            {hash.state === 'mismatch' ? (
              <Badge tone="bad">hash mismatch ✕ — on chain {shortHash(hash.onChain)}</Badge>
            ) : null}
            {hash.state === 'error' ? (
              <span className="small muted">
                Could not fetch the on-chain bytes ({hash.message}). The mint verified: <Mono>{shortHash(order!.contentSha256)}</Mono>
              </span>
            ) : null}
          </p>
        </Panel>
      ) : null}

      {state.recovery && order && !isTerminal(order.status) ? (
        <details className="panel">
          <summary>Recovery bundle</summary>
          <CopyBlock label="Recovery bundle (JSON) — keep private" text={recoveryJson(state.recovery)} rows={8} />
        </details>
      ) : null}

      {order && isTerminal(order.status) ? (
        <div className="actions">
          <Button
            onClick={() => {
              if (order.status === 'delivered') clearRecovery(store);
              dispatch({ type: 'RESET' });
            }}
          >
            Mint another Degent
          </Button>
        </div>
      ) : null}
    </div>
  );
}
