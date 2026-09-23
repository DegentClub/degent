'use client';

import { useEffect, useState } from 'react';
import { isOrdinalsInscriptionId, type StoredOrder } from '@/lib/orders';
import { formatBtc } from '@/lib/fees';

interface OrderTrackerProps {
  order: StoredOrder;
  onUpdate: (patch: Partial<Omit<StoredOrder, 'txid'>>) => void;
  onMintAnother: () => void;
}

const POLL_MS = 30_000;
const MEMPOOL_TX_STATUS = (txid: string) => `https://mempool.space/api/tx/${txid}/status`;

interface TxStatus {
  confirmed: boolean;
  block_height?: number;
}

const TRACK_STEPS = [
  { key: 'paid', label: 'Payment sent', hint: 'Your wallet broadcast the payment.' },
  { key: 'confirmed', label: 'Payment confirmed', hint: 'The payment is in a block.' },
  { key: 'inscribed', label: 'Inscription revealed', hint: 'Skrybit broadcasts the reveal after confirmation.' },
] as const;

export default function OrderTracker({ order, onUpdate, onMintAnother }: OrderTrackerProps) {
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<number | null>(null);

  useEffect(() => {
    if (order.status !== 'paid') return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const res = await fetch(MEMPOOL_TX_STATUS(order.txid), { cache: 'no-store' });
        if (!res.ok) throw new Error(`mempool.space responded ${res.status}`);
        const status = (await res.json()) as TxStatus;
        if (cancelled) return;
        setPollError(null);
        setLastChecked(Date.now());
        if (status.confirmed) {
          onUpdate({ status: 'confirmed', confirmedHeight: status.block_height });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : 'Could not reach mempool.space');
      }
      timer = window.setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [order.txid, order.status, onUpdate]);

  const activeIndex = order.status === 'paid' ? 0 : order.status === 'confirmed' ? 1 : 2;
  const hasRealInscriptionId = isOrdinalsInscriptionId(order.inscriptionId);

  return (
    <section id="transaction" className="degent-card" aria-labelledby="order-tracker-title">
      <h2 id="order-tracker-title" className="degent-title h2">
        <span className="icon-square">
          <i className="fa-solid fa-satellite-dish text-degent-green" aria-hidden="true"></i>
        </span>
        <span>Tracking your <strong>Degent</strong></span>
      </h2>

      <ol className="degent-card-2 !space-y-3">
        {TRACK_STEPS.map((step, index) => {
          const done = index < activeIndex;
          const current = index === activeIndex;
          return (
            <li key={step.key} className="flex items-start gap-3" aria-current={current ? 'step' : undefined}>
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                  done
                    ? 'border-degent-green bg-degent-green text-degent-dark'
                    : current
                      ? 'border-degent-green text-degent-green'
                      : 'border-degent-border text-degent-muted'
                }`}
              >
                {done ? (
                  <i className="fas fa-check" aria-hidden="true"></i>
                ) : current && index < 2 ? (
                  <i className="fas fa-spinner fa-spin" aria-hidden="true"></i>
                ) : (
                  index + 1
                )}
              </span>
              <div>
                <p className={done || current ? 'text-white' : 'text-degent-muted'}>{step.label}</p>
                <p className="text-xs text-degent-muted">{step.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <dl className="degent-card-2 text-sm">
        <div className="degent-row">
          <dt className="text-degent-muted">Payment tx</dt>
          <dd className="break-all font-mono text-xs">
            <a
              href={`https://mempool.space/tx/${order.txid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-degent-green hover:underline"
            >
              {order.txid}
            </a>
          </dd>
        </div>
        <div className="degent-row">
          <dt className="text-degent-muted">Amount</dt>
          <dd>
            {order.amountSats.toLocaleString()} sats ({formatBtc(order.amountSats)} BTC) at {order.feeRate} sat/vB
          </dd>
        </div>
        <div className="degent-row">
          <dt className="text-degent-muted">Recipient</dt>
          <dd className="break-all font-mono text-xs">{order.recipient}</dd>
        </div>
        {order.inscriptionId && (
          <div className="degent-row">
            <dt className="text-degent-muted">Skrybit inscription id</dt>
            <dd className="break-all font-mono text-xs">
              {hasRealInscriptionId ? (
                <a
                  href={`https://ordinals.com/inscription/${order.inscriptionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-degent-green hover:underline"
                >
                  {order.inscriptionId}
                </a>
              ) : (
                order.inscriptionId
              )}
            </dd>
          </div>
        )}
        {order.confirmedHeight !== undefined && (
          <div className="degent-row">
            <dt className="text-degent-muted">Confirmed in block</dt>
            <dd>{order.confirmedHeight.toLocaleString()}</dd>
          </div>
        )}
      </dl>

      {order.status === 'paid' && (
        <p className="info-text status" role="status">
          <i className="fas fa-clock" aria-hidden="true"></i>
          Checking mempool.space every 30s
          {lastChecked ? ` (last: ${new Date(lastChecked).toLocaleTimeString()})` : ''}.
          {pollError ? ` Last attempt failed: ${pollError}` : ''}
        </p>
      )}
      {order.status !== 'paid' && (
        <p className="info-text status success">
          <i className="fas fa-check-circle" aria-hidden="true"></i>
          Payment confirmed. Skrybit will reveal the inscription to your recipient address; keep the ids above for
          support.
        </p>
      )}

      <button type="button" onClick={onMintAnother} className="btn btn-flex btn-idle w-full">
        <i className="fas fa-plus" aria-hidden="true"></i>
        Mint another
      </button>
    </section>
  );
}
