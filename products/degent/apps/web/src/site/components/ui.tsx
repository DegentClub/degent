import { useState, type ReactNode } from 'react';
import { Link } from '../router';
import { useSite } from '../context';
import { gentlemanDataUrl } from '../lib/art';
import type { CollectionItem } from '../services/types';
import { Icon } from './Icons';

export function Pill({ children, tone = 'green' }: { children: ReactNode; tone?: 'green' | 'dark' | 'orange' | 'gold' }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

type CtaVariant = 'gradient' | 'dark' | 'blue' | 'ghost';

export function Cta({
  to,
  href,
  variant = 'gradient',
  icon,
  children,
  className = '',
  ...rest
}: { to?: string; href?: string; variant?: CtaVariant; icon?: ReactNode; children: ReactNode; className?: string; 'aria-label'?: string }) {
  const cls = `cta cta--${variant} ${className}`.trim();
  const body = (
    <>
      <span>{children}</span>
      {icon ? <span className="cta__icon">{icon}</span> : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls} {...rest}>
        {body}
      </Link>
    );
  }
  return (
    <a href={href} className={cls} target="_blank" rel="noopener noreferrer" {...rest}>
      {body}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function SectionTitle({ kicker, title, sub, id, level = 2 }: { kicker?: ReactNode; title: ReactNode; sub?: ReactNode; id?: string; level?: 1 | 2 }) {
  const H = level === 1 ? 'h1' : 'h2';
  return (
    <header className="section-title">
      {kicker ? <Pill>{kicker}</Pill> : null}
      <H id={id} className="section-title__h" tabIndex={level === 1 ? -1 : undefined}>
        {title}
      </H>
      <span className="rule" aria-hidden="true" />
      {sub ? <p className="section-title__sub">{sub}</p> : null}
    </header>
  );
}

/** A Degent image: ord `/content/<id>` live (lazy), a generated placeholder in demo (no network). */
export function DegentImage({ item, eager = false, className = '' }: { item: Pick<CollectionItem, 'id' | 'number'>; eager?: boolean; className?: string }) {
  const { site } = useSite();
  const [failed, setFailed] = useState(false);
  const demo = site.mode === 'demo';
  const src = demo || failed ? gentlemanDataUrl(item.number, { label: demo ? 'DEMO' : 'unavailable' }) : site.ord.contentUrl(item.id);
  return (
    <img
      className={`degent-img ${className}`.trim()}
      src={src}
      alt={`Degent #${item.number}`}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      width={512}
      height={512}
      onError={() => setFailed(true)}
    />
  );
}

/** Gold picture frame with an optional DEGEN plaque and a caption strip. */
export function Frame({ children, plaque, caption, className = '' }: { children: ReactNode; plaque?: string; caption?: ReactNode; className?: string }) {
  return (
    <figure className={`frame ${className}`.trim()}>
      <div className="frame__rail">
        <div className="frame__art">{children}</div>
        {plaque ? (
          <span className="frame__plaque" aria-hidden="true">
            {plaque}
          </span>
        ) : null}
      </div>
      {caption ? <figcaption className="frame__caption">{caption}</figcaption> : null}
    </figure>
  );
}

/** The darkened wall of framed Degents behind heroes (decorative). */
export function Wall({ items, count = 18 }: { items: Array<Pick<CollectionItem, 'id' | 'number'>>; count?: number }) {
  const picks = items.length ? items.slice(0, count) : Array.from({ length: count }, (_, i) => ({ id: `wall-${i}`, number: i + 1 }));
  return (
    <div className="wall" aria-hidden="true">
      {picks.map((it) => (
        <Frame key={it.id} className="frame--wall">
          <DegentImage item={it} />
        </Frame>
      ))}
    </div>
  );
}

export function Hero({
  kicker,
  title,
  sub,
  children,
  wall,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  wall: Array<Pick<CollectionItem, 'id' | 'number'>>;
}) {
  return (
    <section className="hero-wall">
      <Wall items={wall} />
      <div className="hero-wall__shade" aria-hidden="true" />
      <div className="container hero-wall__content">
        {kicker ? <Pill>{kicker}</Pill> : null}
        <h1 className="hero-wall__title" tabIndex={-1}>
          {title}
        </h1>
        <span className="rule rule--center" aria-hidden="true" />
        {sub ? <p className="hero-wall__sub">{sub}</p> : null}
        {children ? <div className="cta-row cta-row--center">{children}</div> : null}
      </div>
    </section>
  );
}

export function ExternalA({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="ext-icon">
        <Icon.external />
      </span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'bad' | 'good' | 'todo'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      {title ? <p className="notice__title">{title}</p> : null}
      {children ? <div className="notice__body">{children}</div> : null}
    </div>
  );
}
