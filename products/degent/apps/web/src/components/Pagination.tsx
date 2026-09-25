/**
 * The collection's pagination toolbar (site spec §3): "Showing 1–20 of N", a per-page selector, a page
 * select ("1 of 206"), first/prev, numbered pages with gaps, next/last and a "Go to" field.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { groupDigits } from '../lib/format';
import { clampPage, pageCount, pageWindow, shownRange } from '../lib/pagination';
import { PER_PAGE_OPTIONS, type Route } from '../lib/router';
import { Icon } from './Icons';
import { Link } from './Link';

export function Pagination({
  total,
  page,
  perPage,
  routeFor,
  onPage,
  onPerPage,
  label = 'Collection pages',
}: {
  total: number;
  page: number;
  perPage: number;
  routeFor: (page: number) => Route;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
  label?: string;
}) {
  const pages = pageCount(total, perPage);
  const { first, last } = shownRange(page, perPage, total);
  const [goto, setGoto] = useState('');
  const [gotoError, setGotoError] = useState<string | null>(null);
  const perId = useId();
  const pageId = useId();
  const gotoId = useId();

  const go = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(goto);
    if (!Number.isInteger(n) || n < 1 || n > pages) {
      setGotoError(`Pages are 1–${groupDigits(pages)}.`);
      return;
    }
    setGotoError(null);
    setGoto('');
    onPage(n);
  };

  const arrow = (to: number, text: string, icon: ReactNode, disabled: boolean, rel?: string) =>
    disabled ? (
      <span className="pgbtn" aria-disabled="true" aria-label={text}>
        {icon}
      </span>
    ) : (
      <Link to={routeFor(to)} className="pgbtn" aria-label={text} {...(rel ? { rel } : {})}>
        {icon}
      </Link>
    );

  return (
    <div className="pgbar" data-testid="pagination">
      <p className="pgbar__count" role="status">
        {total === 0 ? 'No certified members yet.' : `Showing ${groupDigits(first)}–${groupDigits(last)} of ${groupDigits(total)}`}
      </p>
      <div className="pgbar__controls">
        <label htmlFor={perId} className="pgbar__field">
          <span>Per page</span>
          <select id={perId} className="select" value={perPage} onChange={(e) => onPerPage(Number(e.target.value))}>
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={pageId} className="pgbar__field">
          <span className="sr-only">Page</span>
          <select id={pageId} className="select" aria-label="Page" value={page} onChange={(e) => onPage(clampPage(Number(e.target.value), pages))}>
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {`${groupDigits(n)} of ${groupDigits(pages)}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <nav className="pgbar__nav" aria-label={label}>
        {arrow(1, 'First page', <Icon.First />, page <= 1)}
        {arrow(page - 1, 'Previous page', <Icon.ChevronLeft />, page <= 1, 'prev')}
        <span className="pgbar__nums">
          {pageWindow(page, pages).map((n, i) =>
            n === 'gap' ? (
              <span key={`gap-${i}`} className="pgbar__gap" aria-hidden="true">
                …
              </span>
            ) : n === page ? (
              <span key={n} className="pgnum is-on" aria-current="page">
                {groupDigits(n)}
              </span>
            ) : (
              <Link key={n} to={routeFor(n)} className="pgnum" aria-label={`Page ${n}`}>
                {groupDigits(n)}
              </Link>
            ),
          )}
        </span>
        {arrow(page + 1, 'Next page', <Icon.ChevronRight />, page >= pages, 'next')}
        {arrow(pages, 'Last page', <Icon.Last />, page >= pages)}
      </nav>
      <form className="pgbar__goto" onSubmit={go} noValidate>
        <label htmlFor={gotoId}>Go to</label>
        <input
          id={gotoId}
          className="input input--num"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-describedby={gotoError ? `${gotoId}-err` : undefined}
          aria-invalid={gotoError ? true : undefined}
          value={goto}
          onChange={(e) => setGoto(e.target.value)}
        />
        <button type="submit" className="btn btn--dark btn--sm">
          Go
        </button>
        {gotoError ? (
          <span id={`${gotoId}-err`} className="pgbar__err small" role="alert">
            {gotoError}
          </span>
        ) : null}
      </form>
    </div>
  );
}
