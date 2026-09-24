/**
 * "Notify me": email or Telegram news about ONE order (POST /v1/orders/{id}/subscriptions, authorised with the
 * order's private token). The mint sends four messages: the Degent is with the club (member review), the
 * members declined it, self-rescue is open, and it joined the club. On Welcome the choice is only remembered (in
 * memory) and subscribed on Track once the order exists.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { NotifyChannel, Order, OrderSubscription } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import type { NotifyPref } from '../flow/state';
import { Alert, Button, errorText } from './ui';

const LABEL: Record<NotifyChannel, string> = { email: 'Email', telegram_chat: 'Telegram' };
const PLACEHOLDER: Record<NotifyChannel, string> = { email: 'you@example.com', telegram_chat: 'chat id, e.g. 123456789' };
const CLOSED: ReadonlyArray<Order['status']> = ['delivered', 'rejected', 'failed'];

export const NOTIFY_PROMISE =
  'We will write when your Degent is with the club, if the members decline it, if self-rescue opens, and when it joins the club.';

function ChannelFields({ value, onChange, idPrefix }: { value: NotifyPref; onChange: (p: NotifyPref) => void; idPrefix: string }) {
  return (
    <>
      <div role="radiogroup" aria-label="Notify by" className="seg">
        {(Object.keys(LABEL) as NotifyChannel[]).map((c) => (
          <label key={c} className={value.channel === c ? 'is-on' : ''}>
            <input type="radio" name={`${idPrefix}-channel`} checked={value.channel === c} onChange={() => onChange({ ...value, channel: c })} />
            {LABEL[c]}
          </label>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-address`} className="label">
          {value.channel === 'email' ? 'Email address' : 'Telegram chat id'}
        </label>
        <input
          id={`${idPrefix}-address`}
          className="input"
          type={value.channel === 'email' ? 'email' : 'text'}
          autoComplete={value.channel === 'email' ? 'email' : 'off'}
          placeholder={PLACEHOLDER[value.channel]}
          value={value.address}
          onChange={(e) => onChange({ ...value, address: e.currentTarget.value })}
        />
        {value.channel === 'telegram_chat' ? (
          <p className="small muted">Send /start to the club bot in Telegram; it replies with your chat id.</p>
        ) : null}
      </div>
    </>
  );
}

/** Welcome: remember the choice for the order about to be made. */
export function NotifyPreference() {
  const { state, dispatch } = useMint();
  const id = useId();
  const [draft, setDraft] = useState<NotifyPref>(state.notifyPref ?? { channel: 'email', address: '' });
  const saved = state.notifyPref;
  return (
    <div className="notify" data-testid="notify-pref">
      <p className="small">{NOTIFY_PROMISE} Optional; used only for this order.</p>
      {saved ? (
        <div className="row" role="status">
          <span>
            We will notify <strong>{saved.address}</strong> ({LABEL[saved.channel]}) once your order exists.
          </span>
          <Button variant="ghost" onClick={() => dispatch({ type: 'NOTIFY_PREF_SET', pref: null })}>
            Change
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.address.trim()) dispatch({ type: 'NOTIFY_PREF_SET', pref: { ...draft, address: draft.address.trim() } });
          }}
        >
          <ChannelFields value={draft} onChange={setDraft} idPrefix={id} />
          <Button type="submit" variant="secondary" disabled={!draft.address.trim()}>
            Notify me about my order
          </Button>
        </form>
      )}
    </div>
  );
}

/** Track: subscribe this order (and the Welcome choice, automatically, once). */
export function NotifyPanel({ order, token }: { order: Order; token: string | null }) {
  const { state, services } = useMint();
  const id = useId();
  const [draft, setDraft] = useState<NotifyPref>({ channel: state.notifyPref?.channel ?? 'email', address: '' });
  const [subs, setSubs] = useState<OrderSubscription[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auto = useRef(false);

  const subscribe = async (pref: NotifyPref) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const sub = await services.mintApi.subscribeOrder(order.id, token, { channel: pref.channel, address: pref.address });
      setSubs((xs) => [...xs.filter((x) => x.id !== sub.id), sub]);
      setDraft((d) => ({ ...d, address: '' }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // The choice made on Welcome, once, as soon as the order token is here.
  useEffect(() => {
    if (auto.current || !token || !state.notifyPref || CLOSED.includes(order.status)) return;
    auto.current = true;
    void subscribe(state.notifyPref);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, state.notifyPref, order.status]);

  if (CLOSED.includes(order.status)) return null;
  return (
    <section className="panel notify" aria-labelledby={`${id}-title`} data-testid="notify-panel">
      <p className="kicker">Optional</p>
      <h2 className="panel__title" id={`${id}-title`}>
        Notify me
      </h2>
      <p className="small">{NOTIFY_PROMISE}</p>
      {!token ? (
        <Alert tone="info">
          Notifications are tied to this order’s private token, which lives on the device you paid on (and in your recovery
          bundle). Open this page there to subscribe.
        </Alert>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.address.trim()) void subscribe({ ...draft, address: draft.address.trim() });
          }}
        >
          <ChannelFields value={draft} onChange={setDraft} idPrefix={id} />
          <Button type="submit" busy={busy} disabled={!draft.address.trim()}>
            Notify me
          </Button>
        </form>
      )}
      <div aria-live="polite">
        {subs.length ? (
          <ul className="plain small" aria-label="Notifications for this order">
            {subs.map((s) => (
              <li key={s.id}>
                ✓ {LABEL[s.channel]}: <strong>{s.address}</strong>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <Alert tone="warn" title="Could not subscribe">
            {/channel_unavailable|not configured/i.test(error) ? 'This channel is not available on this mint yet. Try the other one.' : error}
          </Alert>
        ) : null}
      </div>
    </section>
  );
}
