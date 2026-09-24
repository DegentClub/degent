/**
 * `/collection`: the certified membership (the Register) as a gallery. Hero, collection card, filters (number,
 * tier, size), sort, "Showing 1–20 of N" with per-page and a full pagination toolbar, and a lightbox with the
 * on-chain details (prefetched per page, so opening one never flashes "LOADING…").
 */
import { useEffect, useId, useState } from 'react';
import type { ExplorerQuery, ExplorerResponse, ExplorerSort, RegisterMember, Tier } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { groupDigits } from '../lib/format';
import { CertifiedStats, HeroWall } from './Home';
import { CtaLink, ExternalButton, GoldFrame, Pill, useDocumentMeta } from '../site/components';
import { useSite } from '../site/data';
import { Lightbox } from '../site/Lightbox';

export const PER_PAGE_OPTIONS = [20, 40, 60, 100] as const;

export const SIZE_FILTERS: ReadonlyArray<{ id: string; label: string; minBytes?: number; maxBytes?: number }> = [
  { id: 'any', label: 'Any size' },
  { id: '200-250', label: '200–250 kB', minBytes: 200_000, maxBytes: 250_000 },
  { id: '250-300', label: '250–300 kB', minBytes: 250_001, maxBytes: 300_000 },
  { id: '300-390', label: '300–390 kB', minBytes: 300_001, maxBytes: 390_000 },
  { id: '390-1000', label: '390 kB – 1 MB', minBytes: 390_001, maxBytes: 1_000_000 },
  { id: '1000+', label: 'Over 1 MB', minBytes: 1_000_001 },
];

/** Page buttons around `current` (0-based) out of `total`: e.g. 1 2 3 4 … 206. */
export function pageWindow(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const set = new Set<number>([0, total - 1, current - 1, current, current + 1]);
  if (current < 4) [0, 1, 2, 3].forEach((i) => set.add(i));
  if (current > total - 5) [total - 4, total - 3, total - 2, total - 1].forEach((i) => set.add(i));
  const pages = [...set].filter((i) => i >= 0 && i < total).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1]! > 1) out.push('…');
    out.push(p);
  });
  return out;
}

function useFirstDegent(): RegisterMember | null {
  const { services } = useMint();
  const [m, setM] = useState<RegisterMember | null>(null);
  useEffect(() => {
    let alive = true;
    services.mintApi
      .getRegisterMember(1)
      .then((x) => alive && setM(x))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [services]);
  return m;
}

export function Collection() {
  const { services, app } = useMint();
  const { info } = useSite();
  const ids = { q: useId(), tier: useId(), size: useId(), sort: useId(), per: useId(), page: useId(), go: useId() };
  const [per, setPer] = useState<number>(20);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<'' | Tier>('');
  const [size, setSize] = useState('any');
  const [sort, setSort] = useState<ExplorerSort>('n');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [data, setData] = useState<ExplorerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [goTo, setGoTo] = useState('');
  const first = useFirstDegent();

  useDocumentMeta({
    title: 'The Collection · degent.club',
    description: "Together we're minting bitcoin's biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising the standard on-chain.",
  });

  useEffect(() => {
    let alive = true;
    const s = SIZE_FILTERS.find((f) => f.id === size) ?? SIZE_FILTERS[0]!;
    const query: ExplorerQuery = { offset: page * per, limit: per, sort, order };
    if (q.trim()) query.q = q.trim();
    if (tier) query.tier = tier;
    if (s.minBytes !== undefined) query.minBytes = s.minBytes;
    if (s.maxBytes !== undefined) query.maxBytes = s.maxBytes;
    services.mintApi
      .getExplorer(query)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        // Prefetch ord details for the whole page: the lightbox opens with its facts already here.
        void info.prefetch(d.items.map((m) => m.id));
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [services, info, page, per, q, tier, size, sort, order]);

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const from = total === 0 ? 0 : page * per + 1;
  const to = Math.min(total, (page + 1) * per);
  const items = data?.items ?? [];
  const reset = () => setPage(0);
  const goToPage = (p: number) => setPage(Math.min(pages - 1, Math.max(0, p)));

  return (
    <div className="page">
      <section className="hero-block">
        <HeroWall items={items} />
        <div className="hero-block__content">
          <Pill>Degens</Pill>
          <h1 tabIndex={-1}>The Collection</h1>
          <span className="green-rule" aria-hidden="true" />
          <p className="lede">
            Together we're minting bitcoin's biggest collection. 10,000 Rare Pepes ordinals in Tuxedos raising the standard
            on-chain.
          </p>
          <div className="row">
            <CtaLink to="/mint">Mint Now</CtaLink>
            <CtaLink to="/how-it-works" variant="dark">
              Learn How
            </CtaLink>
          </div>
        </div>
      </section>

      <div className="collection-top">
        <CertifiedStats />
        <div className="collection-top__side">
          {first ? <GoldFrame src={first.contentUrl} alt="Degent #1" size="lg" /> : null}
          <div className="row">
            {app.socials.x ? <ExternalButton href={app.socials.x}>Twitter</ExternalButton> : null}
            {app.socials.telegram ? (
              <ExternalButton href={app.socials.telegram} variant="telegram">
                Telegram
              </ExternalButton>
            ) : null}
          </div>
        </div>
      </div>

      <section aria-labelledby="grid-title" className="gallery">
        <h2 id="grid-title" className="sr-only">
          Every Degent
        </h2>
        <form className="toolbar filters-bar" role="search" aria-label="Filter the collection" onSubmit={(e) => e.preventDefault()}>
          <div className="field">
            <label htmlFor={ids.q} className="label">
              Number
            </label>
            <input
              id={ids.q}
              className="input"
              inputMode="numeric"
              placeholder="#4113"
              value={q}
              onChange={(e) => {
                setQ(e.currentTarget.value);
                reset();
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.tier} className="label">
              Tier
            </label>
            <select
              id={ids.tier}
              value={tier}
              onChange={(e) => {
                setTier(e.currentTarget.value as '' | Tier);
                reset();
              }}
            >
              <option value="">All tiers</option>
              <option value="standard">Standard Degents</option>
              <option value="block">Block Degents</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.size} className="label">
              Size
            </label>
            <select
              id={ids.size}
              value={size}
              onChange={(e) => {
                setSize(e.currentTarget.value);
                reset();
              }}
            >
              {SIZE_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.sort} className="label">
              Sort
            </label>
            <select
              id={ids.sort}
              value={`${sort}:${order}`}
              onChange={(e) => {
                const [s, o] = e.currentTarget.value.split(':') as [ExplorerSort, 'asc' | 'desc'];
                setSort(s);
                setOrder(o);
                reset();
              }}
            >
              <option value="n:asc">Number, first to last</option>
              <option value="n:desc">Number, newest first</option>
              <option value="bytes:desc">Size, largest first</option>
              <option value="bytes:asc">Size, smallest first</option>
              <option value="height:asc">Block, oldest first</option>
            </select>
          </div>
        </form>

        <div className="toolbar pager-bar">
          <p role="status" className="pager-bar__count" data-testid="showing">
            {data ? `Showing ${groupDigits(from)}–${groupDigits(to)} of ${groupDigits(total)}` : error ? 'The Register is unreachable right now.' : 'Fetching the Register…'}
          </p>
          <div className="field field--inline">
            <label htmlFor={ids.per} className="label">
              Per page
            </label>
            <select
              id={ids.per}
              value={String(per)}
              onChange={(e) => {
                setPer(Number(e.currentTarget.value));
                reset();
              }}
            >
              {PER_PAGE_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="field field--inline">
            <label htmlFor={ids.page} className="label">
              Page
            </label>
            <select id={ids.page} value={String(page)} onChange={(e) => goToPage(Number(e.currentTarget.value))}>
              {Array.from({ length: pages }, (_, i) => (
                <option key={i} value={String(i)}>
                  {i + 1} of {pages}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && data ? <p className="alert alert--warn">{error}</p> : null}

        <ul className="frame-grid" aria-label="Degents on this page">
          {items.map((m, i) => (
            <li key={m.n}>
              <button
                type="button"
                className="frame-card"
                aria-label={`Open Degent #${m.n}`}
                onClick={() => setOpen(i)}
                onMouseEnter={() => void info.load(m.id)}
                onFocus={() => void info.load(m.id)}
              >
                <GoldFrame src={m.contentUrl} alt="" size="sm" />
                <span className="frame-card__caption mono">DEGENT #{m.n}</span>
              </button>
            </li>
          ))}
        </ul>

        <nav className="pagination" aria-label="Pagination">
          <button type="button" className="btn btn--dark btn--sm" disabled={page === 0} onClick={() => goToPage(0)} aria-label="First page">
            «
          </button>
          <button type="button" className="btn btn--dark btn--sm" disabled={page === 0} onClick={() => goToPage(page - 1)} aria-label="Previous page">
            ‹
          </button>
          {pageWindow(page, pages).map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="pagination__gap" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={`btn btn--sm ${p === page ? 'btn--primary' : 'btn--dark'}`}
                aria-label={`Page ${p + 1}`}
                aria-current={p === page ? 'page' : undefined}
                onClick={() => goToPage(p)}
              >
                {p + 1}
              </button>
            ),
          )}
          <button type="button" className="btn btn--dark btn--sm" disabled={page >= pages - 1} onClick={() => goToPage(page + 1)} aria-label="Next page">
            ›
          </button>
          <button type="button" className="btn btn--dark btn--sm" disabled={page >= pages - 1} onClick={() => goToPage(pages - 1)} aria-label="Last page">
            »
          </button>
          <form
            className="pagination__goto"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(goTo);
              if (Number.isInteger(n) && n >= 1) goToPage(n - 1);
            }}
          >
            <label htmlFor={ids.go} className="label">
              Go to
            </label>
            <input id={ids.go} className="input input--narrow" inputMode="numeric" value={goTo} onChange={(e) => setGoTo(e.currentTarget.value)} />
            <button type="submit" className="btn btn--dark btn--sm">
              Go
            </button>
          </form>
        </nav>
      </section>

      {open !== null && items[open] ? <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
