import { useMint } from '../flow/context';
import { shortHash } from '../lib/format';
import { navigate, ROUTE_PATHS, type Route } from '../router';
import { Button } from './ui';

const NAV: Array<{ route: Route; label: string }> = [
  { route: 'mint', label: 'Mint' },
  { route: 'explorer', label: 'Explorer' },
  { route: 'review', label: 'Review' },
];

export function BowtieMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.6} viewBox="0 0 50 30" aria-hidden="true" className="bowtie">
      <path d="M25 15 L3 3 Q0 15 3 27 Z M25 15 L47 3 Q50 15 47 27 Z" fill="currentColor" />
      <rect x="20" y="10" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

export function Header({ route = 'mint' }: { route?: Route }) {
  const { state, dispatch } = useMint();
  const w = state.wallet;
  const locked = state.step === 'pay' && state.pay.phase !== 'idle' && state.pay.phase !== 'error';
  return (
    <header className="header">
      <div className="header__brand">
        <BowtieMark />
        <span className="wordmark">
          degent<span className="wordmark__dot">.</span>club
        </span>
        <span className="header__tag">{route === 'mint' ? 'The Mint' : route === 'review' ? 'The Review' : route === 'explorer' ? 'The Register' : 'The Lounge'}</span>
      </div>
      <nav className="header__nav" aria-label="Site">
        {NAV.map((n) => (
          <a
            key={n.route}
            href={ROUTE_PATHS[n.route]}
            className={`header__link ${route === n.route ? 'header__link--on' : ''}`}
            aria-current={route === n.route ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              navigate(ROUTE_PATHS[n.route]);
            }}
          >
            {n.label}
          </a>
        ))}
      </nav>
      {w ? (
        <div className="header__wallet">
          <span className="chip" title={w.ordinals.address}>
            <span className="chip__dot" aria-hidden="true" />
            {w.name} · <span className="mono">{shortHash(w.ordinals.address, 6)}</span>
          </span>
          <Button
            variant="ghost"
            disabled={locked}
            onClick={() => {
              void w.disconnect().catch(() => undefined);
              dispatch({ type: 'WALLET_DISCONNECTED' });
            }}
          >
            Disconnect
          </Button>
        </div>
      ) : null}
    </header>
  );
}
