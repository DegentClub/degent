import { useSite } from '../flow/site';
import { PROJECTED_TARGET, formatGB, formatMB, formatPct } from '../lib/counts';
import { groupDigits } from '../lib/format';

/** "certified" / "projected" / "demo data" tags: every number on the site says which it is. */
export function Tag({ kind }: { kind: 'certified' | 'projected' | 'demo' }) {
  return <span className={`tag tag--${kind}`}>{kind === 'demo' ? 'demo data' : kind}</span>;
}

export function Gauge({
  label,
  value,
  valueText,
  target,
  targetText,
  pct,
  compact = false,
}: {
  label: string;
  value: number;
  valueText: string;
  target: number;
  targetText: string;
  pct: number;
  compact?: boolean;
}) {
  const { demo } = useSite();
  return (
    <div className={['gauge', compact ? 'gauge--compact' : ''].filter(Boolean).join(' ')} data-testid={`gauge-${label.toLowerCase()}`}>
      {compact ? (
        <p className="gauge__line">
          <span className="gauge__label">{label}</span> <span className="gauge__value mono">{valueText}</span>{' '}
          <span className="gauge__word">{demo ? 'demo' : 'certified'}</span>
          <span className="gauge__target">
            {' '}
            / <span className="mono">{targetText}</span> <span className="gauge__word">projected</span>
          </span>
        </p>
      ) : (
      <p className="gauge__line">
        <span className="gauge__value mono">{valueText}</span> <Tag kind={demo ? 'demo' : 'certified'} />
        <span className="gauge__target">
          {' '}
          / <span className="mono">{targetText}</span> <Tag kind="projected" />
        </span>
        <span className="gauge__pct mono"> · {formatPct(pct)}</span> <span className="gauge__label">{label}</span>
      </p>
      )}
      <div
        className="gauge__bar"
        role="meter"
        aria-label={`${label}: certified against the projected target`}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(value, target)}
        aria-valuetext={`${valueText} certified of ${targetText} projected (${formatPct(pct)})`}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The two live meters (site spec header): Minted and Inscribed, from the attestation. */
export function LiveMeters({ compact = false }: { compact?: boolean }) {
  const { certificate } = useSite();
  if (certificate.status !== 'ready') return null;
  const c = certificate.counts;
  return (
    <div className="meters" aria-label="Collection meters" role="group">
      <Gauge
        compact={compact}
        label="Minted"
        value={c.minted}
        valueText={groupDigits(c.minted)}
        target={PROJECTED_TARGET.supply}
        targetText={groupDigits(PROJECTED_TARGET.supply)}
        pct={c.mintedPct}
      />
      <Gauge
        compact={compact}
        label="Inscribed"
        value={c.bytes}
        valueText={formatMB(c.bytes)}
        target={PROJECTED_TARGET.blockspaceBytes}
        targetText={formatGB(PROJECTED_TARGET.blockspaceBytes)}
        pct={c.bytesPct}
      />
    </div>
  );
}
