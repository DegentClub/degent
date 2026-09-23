/**
 * /explorer — every Degent in the Register: stats header, filter/sort, paginated grid from
 * /v1/explorer, and a member detail view. Public; no wallet needed.
 */
import { useEffect, useState } from 'react';
import type { ExplorerResponse, ExplorerSort, RegisterMember, StatsResponse } from '@bsh/degent-mint-sdk';
import { useMint } from '../flow/context';
import { ScreenHeading } from '../components/ScreenHeading';
import { Badge, Button, ExternalLink, Fact, Mono, Panel, errorText } from '../components/ui';
import { formatSize, groupDigits, shortHash } from '../lib/format';

const PAGE = 24;

function initialQuery(search: string): string {
  try {
    return new URLSearchParams(search).get('q') ?? '';
  } catch {
    return '';
  }
}

export function StatsHeader({ stats }: { stats: StatsResponse }) {
  const pct = ((stats.minted / stats.charter) * 100).toFixed(1);
  const gb = (stats.totalBytes / 1_000_000_000).toFixed(2);
  const weeks = stats.mintsPerWeek.slice(-12);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const hist = stats.sizeHistogram;
  const hmax = Math.max(1, ...hist.map((b) => b.count));
  return (
    <section className="stats" aria-label="Collection statistics" data-testid="stats">
      <dl className="stats__tiles">
        <Fact label="Minted">
          <span className="mono">{groupDigits(stats.minted)}</span> <span className="muted">/ {groupDigits(stats.charter)} ({pct}%)</span>
        </Fact>
        <Fact label="Blockspace">
          <span className="mono">{gb} GB</span>
        </Fact>
        <Fact label="Median size">
          <span className="mono">{formatSize(stats.medianBytes)}</span>
        </Fact>
        <Fact label="In review · approved · declined">
          <span className="mono">
            {stats.approvals.inReview} · {stats.approvals.approved} · {stats.approvals.declined}
          </span>
        </Fact>
      </dl>
      <div className="stats__charts">
        <figure className="minichart">
          <figcaption className="small muted">Mints per week (last {weeks.length})</figcaption>
          <div className="bars" role="img" aria-label={`Mints per week: ${weeks.map((w) => `${w.week} ${w.count}`).join(', ') || 'no data'}`}>
            {weeks.map((w) => (
              <span key={w.week} className="bar" style={{ height: `${Math.max(4, (w.count / max) * 100)}%` }} title={`${w.week}: ${w.count}`} />
            ))}
          </div>
        </figure>
        <figure className="minichart">
          <figcaption className="small muted">Size (KB)</figcaption>
          <div className="bars" role="img" aria-label={`Size histogram: ${hist.map((b) => `${b.from}-${b.to ?? '∞'} KB ${b.count}`).join(', ')}`}>
            {hist.map((b) => (
              <span key={b.from} className="bar bar--brass" style={{ height: `${Math.max(4, (b.count / hmax) * 100)}%` }} title={`${b.from}–${b.to ?? '∞'} KB: ${b.count}`} />
            ))}
          </div>
        </figure>
        {stats.topHolders.length ? (
          <figure className="minichart">
            <figcaption className="small muted">Top holders</figcaption>
            <ol className="holders">
              {stats.topHolders.slice(0, 5).map((h) => (
                <li key={h.owner}>
                  <Mono>{shortHash(h.owner, 5)}</Mono> <span className="mono">{h.count}</span>
                </li>
              ))}
            </ol>
          </figure>
        ) : null}
      </div>
    </section>
  );
}

export function MemberDetail({ member, onBack, explorerUrl }: { member: RegisterMember; onBack: () => void; explorerUrl: string }) {
  return (
    <Panel title={`Degent #${member.n}`} kicker={member.via === 'gallery' ? 'Gallery member (inscribed before the parent)' : 'Child of the club parent'}>
      <div className="member">
        <img className="member__img" src={member.contentUrl} alt={`Degent #${member.n} as rendered from the chain`} />
        <dl className="facts">
          <Fact label="Inscription">
            <ExternalLink href={`${explorerUrl}/inscription/${member.id}`}>
              <Mono wrap>{member.id}</Mono>
            </ExternalLink>
          </Fact>
          <Fact label="Size">
            <span className="mono">{formatSize(member.bytes)}</span> <span className="muted small">({groupDigits(member.bytes)} bytes)</span>
          </Fact>
          <Fact label="Block">
            <span className="mono">{member.height ?? '—'}</span>
          </Fact>
          <Fact label="Inscription number">
            <span className="mono">{member.number !== null ? groupDigits(member.number) : '—'}</span>
          </Fact>
          <Fact label="Owner">{member.owner ? <Mono wrap>{member.owner}</Mono> : <span className="muted">unknown</span>}</Fact>
          {member.sat !== null ? (
            <Fact label="Sat">
              <span className="mono">{groupDigits(member.sat)}</span>
            </Fact>
          ) : null}
        </dl>
      </div>
      <div className="actions">
        <Button variant="secondary" onClick={onBack}>
          Back to the grid
        </Button>
      </div>
    </Panel>
  );
}

export function Explorer() {
  const { services, app } = useMint();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [q, setQ] = useState(() => initialQuery(typeof window !== 'undefined' ? window.location.search : ''));
  const [sort, setSort] = useState<ExplorerSort>('n');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ExplorerResponse | null>(null);
  const [selected, setSelected] = useState<RegisterMember | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    services.mintApi
      .getStats()
      .then((s) => alive && setStats(s))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [services]);

  useEffect(() => {
    let alive = true;
    services.mintApi
      .getExplorer({ offset, limit: PAGE, sort, order, q })
      .then((p) => {
        if (!alive) return;
        setPage(p);
        setError(null);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [services, offset, sort, order, q]);

  const total = page?.total ?? 0;
  const last = Math.max(0, Math.ceil(total / PAGE) - 1);
  const pageNo = Math.floor(offset / PAGE);

  return (
    <div className="screen">
      <ScreenHeading step="The Register" title="Every Degent." lede="The club’s roll, read from the chain: the 4,112 Gallery members and every child of the parent since." />
      {stats ? <StatsHeader stats={stats} /> : null}
      {error ? <p className="alert alert--warn">{error}</p> : null}

      {selected ? (
        <MemberDetail member={selected} onBack={() => setSelected(null)} explorerUrl={app.explorerUrl} />
      ) : (
        <>
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setOffset(0);
            }}
          >
            <label className="label" htmlFor="explorer-q">
              Find
            </label>
            <input
              id="explorer-q"
              className="input"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOffset(0);
              }}
              placeholder="#number, inscription id or owner address"
              spellCheck={false}
            />
            <label className="label" htmlFor="explorer-sort">
              Sort
            </label>
            <select
              id="explorer-sort"
              className="input"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as ExplorerSort);
                setOffset(0);
              }}
            >
              <option value="n">Number</option>
              <option value="bytes">Size</option>
              <option value="height">Block</option>
            </select>
            <Button variant="ghost" onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')} aria-label={`Order ${order === 'asc' ? 'ascending' : 'descending'}, toggle`}>
              {order === 'asc' ? '↑ asc' : '↓ desc'}
            </Button>
          </form>
          <p className="small muted" role="status">
            {page ? `${groupDigits(total)} Degents · page ${pageNo + 1} of ${last + 1}` : 'Loading…'}
          </p>
          <ul className="degent-grid" aria-label="Degents">
            {page?.items.map((m) => (
              <li key={m.n} className="degent-card" data-testid={`degent-${m.n}`}>
                <button type="button" className="degent-card__btn" onClick={() => setSelected(m)} aria-label={`Open Degent #${m.n}`}>
                  <img src={m.contentUrl} alt="" loading="lazy" />
                  <span className="degent-card__meta">
                    <span className="mono">#{m.n}</span>
                    <span className="small muted">{formatSize(m.bytes)}</span>
                  </span>
                  {m.via === 'child' ? <Badge tone="brass">child</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <Button variant="secondary" disabled={pageNo === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </Button>
            <Button variant="secondary" disabled={pageNo >= last} onClick={() => setOffset(offset + PAGE)}>
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
