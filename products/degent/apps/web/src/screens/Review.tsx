/**
 * /review — the members' vote (ADR-0007). Sign in with the wallet that holds a Degent (SIWB via the
 * mint, BIP-322 signature), see every order in member_review with its preview, size and tier, and
 * approve or decline by signing the exact vote statement. One vote per address per order.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReviewItem, VoteChoice } from '@bsh/degent-mint-sdk';
import { voteReference, voteStatement } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { ScreenHeading } from '../components/ScreenHeading';
import { Alert, Badge, Button, ExternalLink, Mono, Panel, errorText } from '../components/ui';
import { formatSize, formatTimestamp, shortHash } from '../lib/format';
import { NotAHolderError, signInAsHolder, type HolderSession } from '../lib/holderSession';
import type { WalletId } from '../services/types';

function previewUrl(item: ReviewItem, contentUrl: (id: string) => string): string {
  const o = item.order;
  return o.inscriptionId ? contentUrl(o.inscriptionId) : contentUrl(`seed:${o.id}`);
}

export function Review() {
  const { services, app } = useMint();
  const [session, setSession] = useState<HolderSession | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wallets = services.wallets.list();

  const load = useCallback(async (s: HolderSession) => {
    const q = await services.mintApi.getReviewQueue(s.token);
    setItems(q.items);
  }, [services]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const timer = setInterval(() => {
      load(session).catch((e) => alive && setError(errorText(e)));
    }, Math.max(app.pollIntervalMs, 2000));
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, load, app.pollIntervalMs]);

  const signIn = async (id: WalletId) => {
    setBusy(id);
    setError(null);
    try {
      const s = await signInAsHolder(services, id, app.network);
      setSession(s);
      await load(s);
    } catch (e) {
      setError(e instanceof NotAHolderError ? e.message : errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const vote = async (item: ReviewItem, choice: VoteChoice) => {
    if (!session) return;
    setBusy(`${item.order.id}:${choice}`);
    setError(null);
    setNotice(null);
    try {
      const message = voteStatement(choice, item.order.id, voteReference(item.order));
      const signature = await session.wallet.signMessage(message, session.address);
      const res = await services.mintApi.castVote(item.order.id, session.token, { vote: choice, message, signature });
      setNotice(
        res.status === 'queued'
          ? `Quorum reached: the order is approved and queued for its parent-linked reveal.`
          : res.status === 'declined'
            ? `Quorum reached: the order is declined. The minter keeps their inscription without the parent link.`
            : `Vote recorded: ${res.approval.approvals} of ${res.approval.approvalQuorum} approvals.`,
      );
      await load(session);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="screen">
      <ScreenHeading
        step="Members only"
        title="The review."
        lede="Every new Degent is admitted by the members. Sign in with the wallet that holds yours, look at each candidate, and sign your vote — it goes on the record as a BIP-322 signature anyone can verify."
      />

      {!session ? (
        <Panel title="Sign in as a member">
          <p className="small">
            You will sign one message (no transaction, no fees). The mint checks the signature and that the address
            currently holds a Degent.
          </p>
          <ul className="wallets" aria-label="Wallets">
            {wallets.map((opt) => (
              <li key={opt.id} className={`wallet ${opt.installed ? '' : 'wallet--missing'}`}>
                <span className="wallet__name">{opt.name}</span>
                {opt.installed ? <Badge tone="good">Installed</Badge> : <Badge>Not installed</Badge>}
                {opt.installed ? (
                  <Button busy={busy === opt.id} disabled={busy !== null} onClick={() => void signIn(opt.id)} aria-label={`Sign in with ${opt.name}`}>
                    Sign in
                  </Button>
                ) : (
                  <ExternalLink href={opt.installUrl}>Install {opt.name}</ExternalLink>
                )}
              </li>
            ))}
          </ul>
          <div aria-live="assertive">{error ? <Alert tone="bad" title="Could not sign in">{error}</Alert> : null}</div>
        </Panel>
      ) : (
        <>
          <Panel title={`Signed in · Degent ${session.degents.map((n) => `#${n}`).join(', ')}`}>
            <p className="small">
              <Mono wrap>{session.address}</Mono> · session until <span className="mono">{formatTimestamp(session.expiresAt)}</span>
            </p>
            <div aria-live="polite">
              {notice ? <Alert tone="good">{notice}</Alert> : null}
              {error ? <Alert tone="bad" title="Vote not recorded">{error}</Alert> : null}
            </div>
          </Panel>

          {items === null ? (
            <p className="muted">Loading the queue…</p>
          ) : items.length === 0 ? (
            <Panel>
              <p>Nothing awaits review. The doorman will let you know.</p>
            </Panel>
          ) : (
            <ul className="review-grid" aria-label="Orders awaiting member review">
              {items.map((item) => {
                const o = item.order;
                const a = item.approval;
                const mine = item.voted;
                const self = o.recipientAddress === session.address;
                return (
                  <li key={o.id} className="candidate" data-testid={`candidate-${o.id}`}>
                    <img className="candidate__img" src={previewUrl(item, services.chain.contentUrl)} alt={`Candidate ${o.id} preview`} />
                    <div className="candidate__body">
                      <p className="kicker">{o.tier === 'block' ? 'Block Degent' : 'Standard Degent'}</p>
                      <p className="small">
                        <Mono>{shortHash(o.id, 6)}</Mono> · {formatSize(o.contentLength)} · {o.contentType}
                      </p>
                      <p className="small">
                        <strong>
                          {a.approvals} of {a.approvalQuorum} approved
                        </strong>
                        {a.declines ? ` · ${a.declines} declined` : ''}
                        {a.reviewDeadline ? <span className="muted"> · decide by {formatTimestamp(a.reviewDeadline)}</span> : null}
                      </p>
                      <p className="small muted">
                        to <Mono>{shortHash(o.recipientAddress, 6)}</Mono> · funded{' '}
                        {o.commitOutpoint ? <ExternalLink href={`${app.explorerUrl}/tx/${o.commitOutpoint.txid}`}>{shortHash(o.commitOutpoint.txid, 6)}</ExternalLink> : '—'}
                      </p>
                      {mine ? (
                        <Badge tone={mine === 'approve' ? 'good' : 'bad'}>You {mine === 'approve' ? 'approved' : 'declined'}</Badge>
                      ) : self ? (
                        <Badge tone="warn">Your own order — members decide</Badge>
                      ) : (
                        <div className="row">
                          <Button busy={busy === `${o.id}:approve`} disabled={busy !== null} onClick={() => void vote(item, 'approve')} aria-label={`Approve ${o.id}`}>
                            Approve
                          </Button>
                          <Button variant="danger" busy={busy === `${o.id}:decline`} disabled={busy !== null} onClick={() => void vote(item, 'decline')} aria-label={`Decline ${o.id}`}>
                            Decline
                          </Button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
