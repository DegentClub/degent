import { useId, useState, type FormEvent } from 'react';
import { PER_PAGE_OPTIONS, pageWindow, parseGoTo, type PageInfo } from '../lib/pagination';
import { Icon } from './Icons';

export function ShowingLine({ info }: { info: PageInfo }) {
  return (
    <p className="showing" aria-live="polite" data-testid="showing">
      Showing {info.total === 0 ? 0 : (info.start + 1).toLocaleString('en-US')}–{info.end.toLocaleString('en-US')} of {info.total.toLocaleString('en-US')}
    </p>
  );
}

/** Per-page select + "page N of M" select (the top toolbar). */
export function PageSelects({ info, onPage, onPerPage }: { info: PageInfo; onPage(p: number): void; onPerPage(n: number): void }) {
  const ids = { per: useId(), page: useId() };
  return (
    <div className="pagesel">
      <label htmlFor={ids.per} className="pagesel__label">
        Per page
      </label>
      <select id={ids.per} value={info.perPage} onChange={(e) => onPerPage(Number(e.target.value))}>
        {PER_PAGE_OPTIONS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <label htmlFor={ids.page} className="pagesel__label">
        Page
      </label>
      <select id={ids.page} value={info.page} onChange={(e) => onPage(Number(e.target.value))} aria-label={`Page, ${info.page} of ${info.pages}`}>
        {Array.from({ length: info.pages }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1} of {info.pages}
          </option>
        ))}
      </select>
    </div>
  );
}

/** first / prev / 1 2 3 4 … N / next / last + "Go to". */
export function Pagination({ info, onPage, label = 'Gallery pages' }: { info: PageInfo; onPage(p: number): void; label?: string }) {
  const goId = useId();
  const [go, setGo] = useState('');
  const [err, setErr] = useState(false);
  const tokens = pageWindow(info.page, info.pages, 1);
  const atFirst = info.page <= 1;
  const atLast = info.page >= info.pages;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = parseGoTo(go, info.pages);
    if (p === null) {
      setErr(true);
      return;
    }
    setErr(false);
    setGo('');
    onPage(p);
  };
  return (
    <nav className="pager" aria-label={label}>
      <ul className="pager__list">
        <li>
          <button type="button" className="pager__btn" onClick={() => onPage(1)} disabled={atFirst} aria-label="First page">
            <Icon.first />
          </button>
        </li>
        <li>
          <button type="button" className="pager__btn" onClick={() => onPage(info.page - 1)} disabled={atFirst} aria-label="Previous page">
            <Icon.chevronLeft />
          </button>
        </li>
        {tokens.map((t, i) =>
          t === 'gap' ? (
            <li key={`gap${i}`} className="pager__gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={t}>
              <button
                type="button"
                className={`pager__btn pager__num ${t === info.page ? 'is-current' : ''}`}
                onClick={() => onPage(t)}
                aria-current={t === info.page ? 'page' : undefined}
                aria-label={`Page ${t}`}
              >
                {t}
              </button>
            </li>
          ),
        )}
        <li>
          <button type="button" className="pager__btn" onClick={() => onPage(info.page + 1)} disabled={atLast} aria-label="Next page">
            <Icon.chevronRight />
          </button>
        </li>
        <li>
          <button type="button" className="pager__btn" onClick={() => onPage(info.pages)} disabled={atLast} aria-label="Last page">
            <Icon.last />
          </button>
        </li>
      </ul>
      <form className="pager__go" onSubmit={submit}>
        <label htmlFor={goId}>Go to</label>
        <input id={goId} inputMode="numeric" value={go} onChange={(e) => setGo(e.target.value)} placeholder="page" aria-invalid={err || undefined} size={5} />
        <button type="submit" className="pager__btn pager__gobtn">
          Go
        </button>
      </form>
    </nav>
  );
}
