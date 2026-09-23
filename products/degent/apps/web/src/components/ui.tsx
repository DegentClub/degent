import { useEffect, useId, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { formatBtc, formatSats } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  busy = false,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
      className={['btn', `btn--${variant}`, className].filter(Boolean).join(' ')}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Panel({ title, kicker, children, className }: { title?: ReactNode; kicker?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={['panel', className].filter(Boolean).join(' ')}>
      {kicker ? <p className="kicker">{kicker}</p> : null}
      {title ? <h2 className="panel__title">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'bad' | 'warn' | 'brass'; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'bad' ? 'alert' : 'note'}>
      {title ? <p className="alert__title">{title}</p> : null}
      {children ? <div className="alert__body">{children}</div> : null}
    </div>
  );
}

/** Sats and BTC side by side, always exact. */
export function Money({ sats, strong = false }: { sats: number | bigint; strong?: boolean }) {
  return (
    <span className={['money', strong ? 'money--strong' : ''].join(' ')}>
      <span className="mono">{formatSats(sats)}</span>
      <span className="money__btc mono">{formatBtc(sats)}</span>
    </span>
  );
}

export function Mono({ children, wrap = false, title }: { children: ReactNode; wrap?: boolean; title?: string }) {
  return (
    <code className={['mono', wrap ? 'mono--wrap' : ''].join(' ')} title={title}>
      {children}
    </code>
  );
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Copyable text: shown in full (select-all on focus), never relying on a download link. */
export function CopyBlock({ label, text, rows = 8 }: { label: string; text: string; rows?: number }) {
  const id = useId();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };
  return (
    <div className="copyblock">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <textarea
        id={id}
        className="copyblock__text mono"
        readOnly
        rows={rows}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
      />
      <div className="row">
        <Button variant="secondary" onClick={copy}>
          Copy to clipboard
        </Button>
        <span role="status" className="muted small">
          {copied === 'ok' ? 'Copied.' : copied === 'fail' ? 'Clipboard blocked: select the text and copy it manually.' : ''}
        </span>
      </div>
    </div>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Object URL for EXACT bytes. Revoked on change/unmount. */
export function useObjectUrl(bytes: Uint8Array | null, type: string): string | null {
  const url = useMemo(() => (bytes ? URL.createObjectURL(new Blob([bytes.slice()], { type })) : null), [bytes, type]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
