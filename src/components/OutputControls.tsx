'use client'
import {
  TARGET_MIN_KB,
  TARGET_MAX_KB,
  MIN_BORDER_PERCENT,
  MAX_BORDER_PERCENT,
} from '@/lib/imageUtils'

interface OutputControlsProps {
  targetKB: number
  onTargetChange: (kb: number) => void
  borderPercent: number
  onBorderChange: (pct: number) => void
  sizeBytes: number
  inRange: boolean
  isGenerating: boolean
}

export default function OutputControls({
  targetKB,
  onTargetChange,
  borderPercent,
  onBorderChange,
  sizeBytes,
  inRange,
  isGenerating,
}: OutputControlsProps) {
  const sizeKB = Math.round(sizeBytes / 1024)

  return (
    <section className="card">
      <p className="eyebrow mb-1">Step three</p>
      <h2 className="text-2xl mb-4">Output</h2>

      <div className="space-y-6">
        <div>
          <div className="flex justify-between items-baseline mb-2">
            <label htmlFor="target-size" className="text-sm text-ink-muted">
              Target file size
            </label>
            <span className="text-sm text-ink-text tabular-nums">{targetKB} KB</span>
          </div>
          <input
            id="target-size"
            type="range"
            min={TARGET_MIN_KB}
            max={TARGET_MAX_KB}
            step={10}
            value={targetKB}
            onChange={(e) => onTargetChange(Number(e.target.value))}
            className="w-full"
            disabled={isGenerating}
          />
          <div className="flex justify-between text-xs text-ink-muted mt-1 tabular-nums">
            <span>{TARGET_MIN_KB} KB</span>
            <span>{TARGET_MAX_KB} KB</span>
          </div>
        </div>

        <div>
          <div className="flex justify-between items-baseline mb-2">
            <label htmlFor="border-width" className="text-sm text-ink-muted">
              Frame border width
            </label>
            <span className="text-sm text-ink-text tabular-nums">{borderPercent}%</span>
          </div>
          <input
            id="border-width"
            type="range"
            min={MIN_BORDER_PERCENT}
            max={MAX_BORDER_PERCENT}
            step={1}
            value={borderPercent}
            onChange={(e) => onBorderChange(Number(e.target.value))}
            className="w-full"
            disabled={isGenerating}
          />
          <div className="flex justify-between text-xs text-ink-muted mt-1">
            <span>Thin ({MIN_BORDER_PERCENT}%)</span>
            <span>Thick ({MAX_BORDER_PERCENT}%)</span>
          </div>
        </div>

        <div className="border-t border-ink-border pt-4 flex justify-between items-center">
          <span className="stat-label">Current size</span>
          <span className={`font-display text-xl tabular-nums ${inRange ? 'text-gold' : 'text-ink-muted'}`}>
            {isGenerating ? 'Encoding…' : `${sizeKB} KB`}
          </span>
        </div>
        {!isGenerating && !inRange && sizeBytes > 0 && (
          <p className="text-xs text-ink-muted -mt-3">
            {sizeKB < TARGET_MIN_KB
              ? 'Even at maximum quality this image encodes below 200 KB. A more detailed portrait or thinner border will add bytes.'
              : 'Even at minimum quality this image encodes above 400 KB. Try a simpler portrait.'}
          </p>
        )}
      </div>
    </section>
  )
}
