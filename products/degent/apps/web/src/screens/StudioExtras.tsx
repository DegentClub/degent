/**
 * ADR-0012 in the Artist Studio: the edition-cap editor, the appeal form for a rejected artwork, and the
 * notification settings with the one-time webhook secret.
 */
import { useId, useState, type FormEvent } from 'react';
import { useMint } from '../flow/context';
import { useStudio } from '../flow/studio';
import { Alert, Badge, Button, CopyBlock, Mono, errorText } from '../components/ui';
import { formatTimestamp } from '../lib/format';
import { editionsOf, latestAppeal, StudioApiError, type AppealStatus, type StudioArtwork } from '../services/studioApi';

export const MAX_EDITIONS_LIMIT = 10_000;
export const APPEAL_MAX_CHARS = 1000;

const studioError = (e: unknown) => (e instanceof StudioApiError ? `${e.message} (${e.code})` : errorText(e));

/** Parse the cap field: '' = open edition (null), else an integer 1..10000; undefined when invalid. */
export function parseCap(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d{1,5}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= MAX_EDITIONS_LIMIT ? n : undefined;
}

/** The cap field for the declare form: "Open edition" or a number (1-10000). */
export function CapField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const id = useId();
  const parsed = parseCap(value);
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        Edition cap <span className="muted small">(optional; empty = open edition, or 1–10,000)</span>
      </label>
      <input
        id={id}
        className="input input--num"
        inputMode="numeric"
        value={value}
        placeholder="Open"
        disabled={disabled}
        aria-invalid={parsed === undefined || undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <p id={`${id}-help`} className="small muted" role={parsed === undefined ? 'alert' : undefined}>
        {parsed === undefined
          ? 'Enter a whole number from 1 to 10,000, or leave it empty for an open edition.'
          : parsed === null
            ? 'Open edition: members can mint it any number of times.'
            : `Limited edition of ${parsed}: once ${parsed} are minted it is sold out. You can raise or open it later, and lower it down to what is already minted.`}
      </p>
    </div>
  );
}

/** Owner-only cap editor on an artwork of the studio list (`PUT /v1/artworks/{id}/editions`). */
export function EditionsEditor({ artwork, onChanged }: { artwork: StudioArtwork; onChanged: (w: StudioArtwork) => void }) {
  const { services } = useMint();
  const { session } = useStudio();
  const e = editionsOf(artwork);
  const [value, setValue] = useState(e.max === null ? '' : String(e.max));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const id = useId();
  const parsed = parseCap(value);
  if (artwork.status === 'delisted') return null;
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!session || parsed === undefined) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const w = await services.studio.setEditions(artwork.id, session.token, parsed);
      onChanged(w);
      setSaved(true);
    } catch (err) {
      setError(studioError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="editions-editor" onSubmit={(ev) => void save(ev)} aria-label={`Edition cap for ${artwork.title}`}>
      <label htmlFor={id} className="small">
        Edition cap
      </label>
      <input
        id={id}
        className="input input--num"
        inputMode="numeric"
        placeholder="Open"
        value={value}
        aria-invalid={parsed === undefined || undefined}
        onChange={(ev) => {
          setValue(ev.currentTarget.value);
          setSaved(false);
        }}
      />
      <Button type="submit" variant="secondary" className="btn--sm" busy={busy} disabled={parsed === undefined}>
        Save cap
      </Button>
      <span className="small muted">
        {e.minted !== null ? `${e.minted} minted` : ''}
        {saved ? ' · saved' : ''}
      </span>
      {error ? (
        <span className="small editions-editor__err" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

const APPEAL_TONE: Record<AppealStatus, { label: string; tone: 'warn' | 'good' | 'bad' }> = {
  open: { label: 'Appeal open', tone: 'warn' },
  granted: { label: 'Appeal granted', tone: 'good' },
  denied: { label: 'Appeal denied', tone: 'bad' },
};

export function AppealBadge({ artwork }: { artwork: Pick<StudioArtwork, 'appeals'> }) {
  const a = latestAppeal(artwork);
  if (!a) return null;
  const c = APPEAL_TONE[a.status];
  return <Badge tone={c.tone}>{c.label}</Badge>;
}

/** Appeal a rejection (`POST /v1/artworks/{id}/appeal`, message 1..1000). Shown on rejected artworks. */
export function AppealForm({ artwork, onAppealed }: { artwork: StudioArtwork; onAppealed: (w: StudioArtwork) => void }) {
  const { services } = useMint();
  const { session } = useStudio();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (artwork.status !== 'rejected') return null;
  const used = artwork.appeals?.length ?? 0;
  const last = latestAppeal(artwork);
  const text = message.trim();
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!session || text.length === 0 || text.length > APPEAL_MAX_CHARS) return;
    setBusy(true);
    setError(null);
    try {
      const res = await services.studio.appeal(artwork.id, session.token, text);
      onAppealed(res.artwork);
      setOpen(false);
      setMessage('');
    } catch (err) {
      setError(studioError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="appeal">
      {last?.status === 'denied' && last.resolution ? (
        <p className="small">
          The house denied your last appeal {last.resolvedAt ? <>on {formatTimestamp(last.resolvedAt)}</> : null}
          {last.resolution.reasons.length > 0 ? <>: {last.resolution.reasons.join('; ')}</> : '.'}
        </p>
      ) : null}
      {!open ? (
        <Button variant="secondary" className="btn--sm" onClick={() => setOpen(true)} disabled={used >= 3}>
          Appeal to the house
        </Button>
      ) : (
        <form onSubmit={(ev) => void submit(ev)} className="appeal__form">
          <label htmlFor={id} className="label">
            Why does this piece meet the rules? <span className="muted small">({message.length}/{APPEAL_MAX_CHARS})</span>
          </label>
          <textarea id={id} rows={3} maxLength={APPEAL_MAX_CHARS} value={message} onChange={(e) => setMessage(e.currentTarget.value)} />
          <p className="small muted">A person at the house reads it and decides. {3 - used} of 3 appeals left for this piece.</p>
          <div className="row">
            <Button type="submit" className="btn--sm" busy={busy} disabled={text.length === 0}>
              Send appeal
            </Button>
            <Button variant="ghost" className="btn--sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {used >= 3 ? <p className="small muted">All 3 appeals for this piece are used.</p> : null}
      {error ? <Alert tone="bad" title="The appeal was not sent">{error}</Alert> : null}
    </div>
  );
}

/**
 * Notification settings (`PUT /v1/artists/me` `notify`). The webhook signing secret comes back ONCE: it is
 * shown here with a copy button and kept only in this component's memory, never stored.
 */
export function NotifySettings() {
  const { services } = useMint();
  const { session, artist, setArtist } = useStudio();
  const current = artist?.notify ?? null;
  const [webhookUrl, setWebhookUrl] = useState(current?.webhookUrl ?? '');
  const [chat, setChat] = useState(current?.telegramChatId ?? '');
  const [busy, setBusy] = useState<'save' | 'rotate' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ids = { url: useId(), chat: useId() };
  if (!session || !artist) return null;

  const run = async (kind: 'save' | 'rotate' | 'clear') => {
    setBusy(kind);
    setError(null);
    setSaved(false);
    try {
      const notify =
        kind === 'clear'
          ? null
          : kind === 'rotate'
            ? { rotateWebhookSecret: true }
            : { webhookUrl: webhookUrl.trim() === '' ? null : webhookUrl.trim(), telegramChatId: chat.trim() === '' ? null : chat.trim() };
      const a = await services.studio.updateMe(session.token, { notify });
      const { notifyWebhookSecret, ...rest } = a;
      setArtist(rest);
      setSecret(notifyWebhookSecret ?? null);
      if (kind === 'clear') {
        setWebhookUrl('');
        setChat('');
      }
      setSaved(true);
    } catch (e) {
      setError(studioError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="notify" aria-labelledby={`${ids.url}-h`}>
      <h3 id={`${ids.url}-h`} className="h3">
        Notifications
      </h3>
      <p className="small muted">
        The studio tells you when a piece is approved, rejected or waits for the house, and when a royalty is recorded.
      </p>
      <form
        className="notify__form"
        onSubmit={(e) => {
          e.preventDefault();
          void run('save');
        }}
      >
        <div className="field">
          <label htmlFor={ids.url} className="label">
            Webhook URL <span className="muted small">(https)</span>
          </label>
          <input id={ids.url} className="input" type="url" placeholder="https://example.com/degent-hook" value={webhookUrl} onChange={(e) => setWebhookUrl(e.currentTarget.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.chat} className="label">
            Telegram chat <span className="muted small">(numeric id or @channel)</span>
          </label>
          <input id={ids.chat} className="input" type="text" placeholder="@mychannel" value={chat} onChange={(e) => setChat(e.currentTarget.value)} />
        </div>
        <div className="row">
          <Button type="submit" variant="secondary" busy={busy === 'save'}>
            Save notifications
          </Button>
          {current?.webhookSecretSet ? (
            <Button variant="ghost" busy={busy === 'rotate'} onClick={() => void run('rotate')}>
              Rotate webhook secret
            </Button>
          ) : null}
          {current?.webhookUrl || current?.telegramChatId ? (
            <Button variant="ghost" busy={busy === 'clear'} onClick={() => void run('clear')}>
              Turn notifications off
            </Button>
          ) : null}
          <span className="small muted" role="status">
            {saved ? 'Saved.' : ''}
          </span>
        </div>
      </form>
      {current ? (
        <p className="small muted" data-testid="notify-state">
          Webhook: {current.webhookUrl ? <Mono wrap>{current.webhookUrl}</Mono> : 'off'}
          {current.webhookUrl ? (current.webhookSecretSet ? ' · signing secret set' : ' · no signing secret') : null} · Telegram:{' '}
          {current.telegramChatId ? <Mono wrap>{current.telegramChatId}</Mono> : 'off'}
        </p>
      ) : null}
      {error ? <Alert tone="bad" title="Notifications were not saved">{error}</Alert> : null}
      {secret ? (
        <Alert tone="warn" title="Your webhook signing secret: shown once">
          <p>
            Copy it now and keep it with your webhook receiver: it verifies the <code>Bsh-Signature</code> header of every
            delivery. The studio never shows it again; if you lose it, rotate it.
          </p>
          <CopyBlock label="Webhook signing secret" text={secret} rows={2} />
          <div className="row">
            <Button variant="ghost" className="btn--sm" onClick={() => setSecret(null)}>
              I have stored it, hide it
            </Button>
          </div>
        </Alert>
      ) : null}
    </section>
  );
}
