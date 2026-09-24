/** Building blocks of the site pages: internal links, the two mint meters, gold frames, page meta. */
import { useEffect, type ReactNode } from 'react';
import { CHARTER_SIZE } from '@bsh/degent-mint-sdk';
import { onInternalClick } from '../router';
import { groupDigits } from '../lib/format';
import { PROJECTED_CHARTER_BYTES, useSite } from './data';

export function SiteLink({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string; 'aria-label'?: string; 'aria-current'?: 'page' | undefined }) {
  return (
    <a href={to} className={className} onClick={onInternalClick(to)} {...rest}>
      {children}
    </a>
  );
}

/** Gradient call to action (internal link). */
export function CtaLink({ to, children, variant = 'primary' }: { to: string; children: ReactNode; variant?: 'primary' | 'dark' }) {
  return (
    <SiteLink to={to} className={`btn btn--${variant === 'primary' ? 'primary' : 'dark'}`}>
      {children}
    </SiteLink>
  );
}

export function ExternalButton({ href, children, variant = 'dark' }: { href: string; children: ReactNode; variant?: 'primary' | 'dark' | 'telegram' }) {
  return (
    <a href={href} className={`btn btn--${variant}`} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return <span className="pill">{children}</span>;
}

/** An accessible meter with the live header's green→yellow bar. */
export function Meter({ label, value, max, text, testId }: { label: string; value: number | null; max: number; text: string; testId?: string }) {
  const pct = value === null ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="meter-bar" data-testid={testId}>
      <span className="meter-bar__text mono">{text}</span>
      <div
        className="meter-bar__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value ?? 0}
        aria-valuetext={text}
      >
        <span className="meter-bar__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

/**
 * "4,112 / 10K · 41.12% MINTED" and "1,508MB / 3GB · 50.27% INSCRIBED" from /v1/stats. The 3 GB is the projected
 * size of the full charter, labelled as such; the MB figure is certified by the Register.
 */
export function MintMeters({ compact = false }: { compact?: boolean }) {
  const { stats } = useSite();
  const minted = stats?.minted ?? null;
  const bytes = stats?.totalBytes ?? null;
  const charter = stats?.charter ?? CHARTER_SIZE;
  const mintedText = minted === null ? '— / 10K minted' : `${groupDigits(minted)} / 10K · ${((minted / charter) * 100).toFixed(2)}% MINTED`;
  const bytesText =
    bytes === null ? '— / 3GB inscribed' : `${groupDigits(mb(bytes))}MB / 3GB · ${((bytes / PROJECTED_CHARTER_BYTES) * 100).toFixed(2)}% INSCRIBED`;
  return (
    <div className={`meters ${compact ? 'meters--compact' : ''}`} aria-label="Mint progress" role="group">
      <Meter label="Degents minted of 10,000" value={minted} max={charter} text={mintedText} testId="meter-minted" />
      <Meter label="Blockspace inscribed of the projected 3 GB" value={bytes} max={PROJECTED_CHARTER_BYTES} text={bytesText} testId="meter-bytes" />
    </div>
  );
}

/** A Degent in a gold frame with its plaque (the club's motif). */
export function GoldFrame({ src, alt, plaque = 'DEGEN', size = 'md' }: { src: string; alt: string; plaque?: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <figure className={`goldframe goldframe--${size}`}>
      <img src={src} alt={alt} loading="lazy" />
      <figcaption className="goldframe__plaque" aria-hidden="true">
        {plaque}
      </figcaption>
    </figure>
  );
}

export interface PageMeta {
  title: string;
  description?: string;
  image?: string;
  url?: string;
  /** schema.org JSON-LD for the page. */
  jsonLd?: Record<string, unknown>;
}

function setMeta(attr: 'name' | 'property', key: string, content: string | undefined): () => void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  const created = !el;
  const previous = el?.getAttribute('content') ?? null;
  if (content === undefined) return () => undefined;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
  return () => {
    if (created) el!.remove();
    else if (previous !== null) el!.setAttribute('content', previous);
  };
}

/**
 * Title, description, OpenGraph/Twitter tags and JSON-LD for client-side navigation and for crawlers that run
 * JavaScript. Link unfurlers (X, Telegram, Discord) do NOT run JavaScript: per-Degent OpenGraph images need the
 * edge/server rendering described in the README ("Share cards").
 */
export function useDocumentMeta(meta: PageMeta | null): void {
  const key = meta ? JSON.stringify(meta) : '';
  useEffect(() => {
    if (!meta) return;
    const prevTitle = document.title;
    document.title = meta.title;
    const undo = [
      setMeta('name', 'description', meta.description),
      setMeta('property', 'og:title', meta.title),
      setMeta('property', 'og:description', meta.description),
      setMeta('property', 'og:image', meta.image),
      setMeta('property', 'og:url', meta.url),
      setMeta('property', 'og:type', 'website'),
      setMeta('name', 'twitter:card', meta.image ? 'summary_large_image' : 'summary'),
      setMeta('name', 'twitter:title', meta.title),
      setMeta('name', 'twitter:image', meta.image),
    ];
    let script: HTMLScriptElement | null = null;
    if (meta.jsonLd) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.dataset.page = 'degent';
      // `<` escaped so the JSON can never close the script element.
      script.textContent = JSON.stringify(meta.jsonLd).replace(/</g, '\\u003c');
      document.head.appendChild(script);
    }
    return () => {
      document.title = prevTitle;
      for (const u of undo.reverse()) u();
      script?.remove();
    };
    // `key` captures every field of `meta`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
