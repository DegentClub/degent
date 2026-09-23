'use client'
import { downloadImage, estimateInscription, CANVAS_SIZE } from '@/lib/imageUtils'

interface FinalImageDisplayProps {
  imageUrl: string
  sizeBytes: number
  inRange: boolean
}

const fmt = new Intl.NumberFormat('en-US')

export default function FinalImageDisplay({ imageUrl, sizeBytes, inRange }: FinalImageDisplayProps) {
  const estimate = estimateInscription(sizeBytes, 1)
  const sizeKB = Math.round(sizeBytes / 1024)

  const handleDownload = () => {
    downloadImage(imageUrl, `degent-frame-${Date.now()}.jpg`)
  }

  return (
    <section className="card">
      <div className="flex justify-between items-start mb-4 gap-4">
        <div>
          <p className="eyebrow mb-1">Result</p>
          <h2 className="text-2xl">Your Degent</h2>
        </div>
        <button onClick={handleDownload} className="btn-primary py-2">
          Download JPEG
        </button>
      </div>

      <div className="space-y-4">
        <div className="rounded-md overflow-hidden border border-ink-border">
          {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
          <img src={imageUrl} alt="Framed portrait" className="w-full h-auto" />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="bg-ink rounded-md p-3 border border-ink-border">
            <dt className="stat-label mb-1">Dimensions</dt>
            <dd className="text-ink-text tabular-nums">
              {CANVAS_SIZE} × {CANVAS_SIZE} px · JPEG
            </dd>
          </div>
          <div className="bg-ink rounded-md p-3 border border-ink-border">
            <dt className="stat-label mb-1">File size</dt>
            <dd className={`tabular-nums ${inRange ? 'text-gold' : 'text-ink-text'}`}>
              {sizeKB} KB ({fmt.format(sizeBytes)} bytes)
            </dd>
          </div>
          <div className="bg-ink rounded-md p-3 border border-ink-border">
            <dt className="stat-label mb-1">Estimated inscription</dt>
            <dd className="text-ink-text tabular-nums">~{fmt.format(estimate.totalVBytes)} vB</dd>
          </div>
          <div className="bg-ink rounded-md p-3 border border-ink-border">
            <dt className="stat-label mb-1">Fee at 1 sat/vB</dt>
            <dd className="text-btc tabular-nums">~{fmt.format(estimate.feeSats)} sats</dd>
          </div>
        </dl>

        <div className={`rounded-md p-4 border ${inRange ? 'border-gold/40 bg-gold-soft' : 'border-ink-border'}`}>
          <p className={`font-display ${inRange ? 'text-gold' : 'text-ink-text'}`}>
            {inRange ? 'Ready for the Degent mint (200–400 KB)' : 'Outside the 200–400 KB window'}
          </p>
          <p className="text-xs text-ink-muted mt-1">
            Content bytes sit in the witness at 1 weight unit each (¼ vB per byte) plus ~200 vB of commit/reveal
            overhead. Multiply the vbytes by the fee rate at mint time.
          </p>
        </div>
      </div>
    </section>
  )
}
