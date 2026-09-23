import { useEffect, useState } from 'react';
import type { Order, VotesResponse } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { rescue } from '../flow/effects';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, CopyBlock, ExternalLink, Mono, Panel, errorText, useObjectUrl } from '../components/ui';
import { buildStages, buildTimeline, isTerminal, rescueOffered, STATUS_COPY } from '../lib/timeline';
import { clearRecovery, recoveryJson } from '../lib/recovery';
import { formatSize, formatTimestamp, shortHash } from '../lib/format';
import type { Services } from '../services/types';

/** The four stages of ADR-0005: Design -> Mint -> Confirm -> Approve. */
export function Stages({ order }: { order: Pick<Order, 'status'> }) {
  return (
    <ol className="stages" aria-label="Mint stages">
      {buildStages(order).map((s, i) => (
        <li key={s.stage} className={`stage stage--${s.state}`} data-testid={`stage-${s.stage}`} data-state={s.state} aria-current={s.state === 'current' || s.state === 'problem' ? 'step' : undefined}>
          <span className="stage__num" aria-hidden="true">{i + 1}</span>
          <span className="stage__label">{s.label}</span>
          <span className="sr-only"> — {s.state === 'done' ? 'done' : s.state === 'current' ? 'in progress' : s.state === 'problem' ? 'needs attention' : 'not yet'}</span>
          <span className="stage__blurb">{s.blurb}</span>
        </li>
      ))}
    </ol>
  );
}

/** Live tally while the members vote: "2 of 3 members have approved". */
export function Votes({ order, services, pollMs }: { order: Order; services: Services; pollMs: number }) {
  const [votes, setVotes] = useState<VotesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewing = order.status === 'member_review';
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const v = await services.mintApi.getVotes(order.id);
        if (!alive) return;
        setVotes(v);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(errorText(e));
      }
      if (reviewing) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [order.id, reviewing, services, pollMs]);
  const a = votes?.approval ?? order.approval;
  if (!a) return null;
  const deadline = a.reviewDeadline ? formatTimestamp(a.reviewDeadline) : null;
  return (
    <div className="votes" aria-live="polite" data-testid="votes">
      <p className="votes__headline">
        <strong>
          {a.approvals} of {a.approvalQuorum} members have approved
        </strong>
        {a.declines > 0 ? (
          <>
            {' '}
            · {a.declines} of {a.declineQuorum} declined
          </>
        ) : null}
      </p>
      <div className="votebar" role="img" aria-label={`${a.approvals} approvals of ${a.approvalQuorum} needed`}>
        {Array.from({ length: a.approvalQuorum }, (_, i) => (
          <span key={i} className={`votebar__seg ${i < a.approvals ? 'votebar__seg--on' : ''}`} />
        ))}
      </div>
      {votes && votes.votes.length > 0 ? (
        <ul className="votelist" aria-label="Votes">
          {votes.votes.map((v) => (
            <li key={`${v.degent}-${v.at}`}>
              <Badge tone={v.vote === 'approve' ? 'good' : 'bad'}>{v.vote === 'approve' ? 'Approved' : 'Declined'}</Badge> by Degent{' '}
              <span className="mono">#{v.degent}</span> <span className="muted small">· {formatTimestamp(v.at)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {reviewing && deadline ? (
        <p className="small muted">
          Every vote is a BIP-322 signature by a member’s wallet, verifiable by anyone. If the club has not decided by{' '}
          <span className="mono">{deadline}</span>, self-rescue is offered so your funds are never stranded.
        </p>
      ) : null}
      {error ? <p className="small muted">Could not refresh the votes: {error}</p> : null}
    </div>
  );
}

/** Delivered: a card worth showing off. */
export function ShareCard({ order, siteUrl, imageUrl }: { order: Order; siteUrl: string; imageUrl: string }) {
  const n = order.degentNumber;
  const title = n !== null ? `Degent #${n}` : 'A new inscription';
  const link = n !== null ? `${siteUrl}/explorer?q=${n}` : `${siteUrl}/`;
  const text = n !== null
    ? `Degent #${n} has joined the Decentralized Gentlemen Club — ${formatSize(order.contentLength)} inscribed on Bitcoin, approved by the members. ${link}`
    : `Inscribed on Bitcoin (${formatSize(order.contentLength)}), the non-custodial way. ${link}`;
  const tweet = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  return (
    <section className="sharecard" aria-label="Share card" data-testid="share-card">
      <img className="sharecard__img" src={imageUrl} alt={`${title} as rendered from the chain`} />
      <div className="sharecard__body">
        <p className="kicker">{order.rescued ? 'Inscribed without the parent link' : 'Member of the club'}</p>
        <h3 className="sharecard__title">{title}</h3>
        <p className="small">
          {formatSize(order.contentLength)} · {order.tier === 'block' ? 'Block Degent' : 'Standard Degent'} · <Mono>{shortHash(order.inscriptionId ?? '', 6)}</Mono>
        </p>
        <div className="row">
          <ExternalLink href={tweet}>Share on X</ExternalLink>
          <a className="link" href={link}>
            View in the Explorer
          </a>
        </div>
      </div>
    </section>
  );
}

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
        },
      );
      setRescueState({ state: 'done', ...r });
    } catch (e) {
      setRescueState({ state: 'error', message: errorText(e) });
    }
  };

  const commitTxid = order?.commitOutpoint?.txid ?? state.recovery?.commitTxid ?? state.pay.commitTxid;

  return (
    <div className="screen">
      <ScreenHeading
        step="Step 7 of 7"
        title="From mempool to membership."
        lede="Design → Mint → Confirm → Approve. This page follows your order on its own. You can close it — reopen the site on this device to resume."
      />

      {order ? <Stages order={order} /> : null}

      <Panel title="Status">
        <div aria-live="polite" className="status-now">
          {order ? (
            <p>
              <Badge tone={order.status === 'delivered' || order.status === 'verified' ? 'good' : rescueOffered(order.status) || order.status === 'failed' || order.status === 'rejected' || order.status === 'expired' ? 'bad' : 'brass'}>
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
        {order?.queue && order.queue.position !== null ? (
          <p className="small">
            Queue: position <span className="mono">{order.queue.position}</span> in the {order.queue.lane} lane · ETA{' '}
            <span className="mono">~{order.queue.etaMinutes ?? '?'} min</span>
          </p>
        ) : null}
        {order?.degentNumber !== null && order?.degentNumber !== undefined ? (
          <p className="small">
            The members approved: this is <strong>Degent #{order.degentNumber}</strong>.
          </p>
        ) : null}
        {order ? <Timeline order={order} explorerUrl={app.explorerUrl} /> : null}
      </Panel>

      {order && (order.status === 'member_review' || order.approval) && !isTerminal(order.status) ? (
        <Panel title="Member approval" kicker="Stage 4 · Approve">
          <p>
            Every new Degent is approved by existing members before the club co-signs the parent link. Approval{' '}
            <em>is</em> membership: the parent link is applied at reveal.
          </p>
          <Votes order={order} services={services} pollMs={app.pollIntervalMs} />
        </Panel>
      ) : null}

      {order && rescueOffered(order.status) ? (
        <Panel title={order.status === 'declined' ? 'The members declined — keep your inscription' : 'Rescue your Degent'} kicker="Self-custody, as promised">
          {order.status === 'declined' ? (
            <p>
              The club voted not to admit this piece. Nothing is lost: your funding is sitting in the commit output and
              your pre-signed reveal still works <em>without</em> the parent. Broadcast it and the inscription lands in
              your ordinals address — it is simply not a Degent.
            </p>
          ) : (
            <p>
              The mint has not revealed your Degent in time. Your pre-signed reveal was signed with{' '}
              <Mono>SIGHASH_SINGLE | ANYONECANPAY</Mono>, so the same signature also works in a simple one-input,
              one-output transaction: <em>commit → your ordinals address</em>. Broadcasting it lands the inscription
              now, without the on-chain parent link to the collection. Your sats and your art are never stranded.
            </p>
          )}
          {!state.recovery ? (
            <p className="small muted">No local recovery bundle on this device: the mint’s rescue endpoint will be used.</p>
          ) : null}
          <div className="actions">
            <Button variant="danger" busy={rescueState.state === 'busy'} disabled={rescueState.state === 'done'} onClick={() => void doRescue()}>
              {order.status === 'declined' ? 'Reveal without the parent (keep my inscription)' : 'Rescue now (reveal without parent)'}
            </Button>
          </div>
          <div aria-live="assertive">
            {rescueState.state === 'done' ? (
              <Alert tone="good" title="Rescue broadcast">
                Reveal tx <ExternalLink href={`${app.explorerUrl}/tx/${rescueState.txid}`}>{rescueState.txid}</ExternalLink>
                {rescueState.source === 'local' ? ' — built in your browser from the recovery bundle.' : ' — built by the mint service.'}
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
          {order?.status === 'delivered' ? <ShareCard order={order} siteUrl={app.siteUrl} imageUrl={services.chain.contentUrl(inscriptionId)} /> : null}
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
