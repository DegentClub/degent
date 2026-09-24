import { useId } from 'react';
import type { Async } from '../context';
import type { CollectionStats } from '../services/types';
import { BLOCKSPACE_GOAL_BYTES, formatCount, formatMB, formatPct, pct, supplyLabel } from '../lib/stats';

export function provenance(s: CollectionStats): string {
  if (s.source === 'certified') {
    const at = s.certifiedAt ? ` (${s.certifiedAt.slice(0, 10)})` : '';
    return s.certifiedHeight !== null
      ? `Certified by block.space at block ${formatCount(s.certifiedHeight)}${at}`
      : `Certified by block.space${at}`;
  }
  return 'Bundled manifest snapshot: not certified (demo)';
}

function Bar({ value, label, testid }: { value: number; label: string; testid: string }) {
  const v = Math.min(100, value);
  return (
    <span className="meter-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(v.toFixed(2))} data-testid={testid}>
      <span className="meter-bar__fill" style={{ width: `${v}%` }} />
    </span>
  );
}

/** The two live meters (minted N / supply, inscribed MB / 3 GB goal), bound to StatsService only. */
export function Meters({ stats, compact = false }: { stats: Async<CollectionStats>; compact?: boolean }) {
  const tipId = useId();
  const t = compact ? 'strip-' : '';
  if (stats.status !== 'ok') {
    return (
      <div className={`meters ${compact ? 'meters--compact' : ''}`} data-testid={`${t}meters`} aria-live="polite">
        <span className="meters__na">{stats.status === 'loading' ? 'Loading collection stats…' : 'Collection stats unavailable'}</span>
      </div>
    );
  }
  const s = stats.value;
  const mintedPct = pct(s.minted, s.supply);
  const bytesPct = pct(s.bytes, BLOCKSPACE_GOAL_BYTES);
  const tip = provenance(s);
  return (
    <div className={`meters ${compact ? 'meters--compact' : ''}`} data-testid={`${t}meters`} data-source={s.source}>
      <div className="meter-group" tabIndex={0} aria-describedby={tipId} title={tip}>
        <span className="meter-group__line">
          <span className="meter-group__num" data-testid={`${t}meter-minted`}>
            {formatCount(s.minted)} / {supplyLabel(s.supply)}
          </span>
          <span className="meter-group__pct">
            {formatPct(mintedPct)} <span className="meter-group__word">minted</span>
          </span>
        </span>
        <Bar value={mintedPct} label="Minted of supply" testid={`${t}bar-minted`} />
      </div>
      <div className="meter-group" tabIndex={0} aria-describedby={tipId} title={tip}>
        <span className="meter-group__line">
          <span className="meter-group__num" data-testid={`${t}meter-bytes`}>
            {formatMB(s.bytes)} / 3 GB
          </span>
          <span className="meter-group__pct">
            {formatPct(bytesPct)} <span className="meter-group__word">inscribed</span>
          </span>
        </span>
        <Bar value={bytesPct} label="Inscribed of the 3 GB goal" testid={`${t}bar-bytes`} />
      </div>
      <span id={tipId} role="tooltip" className={`meters__tip ${s.source === 'certified' ? 'is-certified' : ''}`} data-testid={`${t}meters-tip`}>
        {s.source === 'certified' ? '✓ ' : ''}
        {tip}
      </span>
    </div>
  );
}
