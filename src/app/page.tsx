'use client'
import { useState, useEffect, useRef } from 'react'
import { combineImagesToTargetSize, DEFAULT_BORDER_PERCENT } from '@/lib/imageUtils'
import FrameGenerator from '@/components/FrameGenerator'
import ImageUploader from '@/components/ImageUploader'
import OutputControls from '@/components/OutputControls'
import FinalImageDisplay from '@/components/FinalImageDisplay'

export default function Home() {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [userImageUrl, setUserImageUrl] = useState<string | null>(null)
  const [combinedUrl, setCombinedUrl] = useState<string | null>(null)
  const [targetKB, setTargetKB] = useState(300)
  const [borderPercent, setBorderPercent] = useState(DEFAULT_BORDER_PERCENT)
  const [sizeBytes, setSizeBytes] = useState(0)
  const [inRange, setInRange] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runId = useRef(0)

  useEffect(() => {
    if (!frameUrl || !userImageUrl) return
    const id = ++runId.current
    setIsGenerating(true)
    setError(null)

    const handle = setTimeout(() => {
      combineImagesToTargetSize(userImageUrl, frameUrl, targetKB, { borderPercent })
        .then((result) => {
          if (id !== runId.current) return
          setCombinedUrl(result.dataUrl)
          setSizeBytes(result.sizeBytes)
          setInRange(result.inRange)
        })
        .catch((err: unknown) => {
          if (id !== runId.current) return
          setError(err instanceof Error ? err.message : 'Could not combine images')
        })
        .finally(() => {
          if (id === runId.current) setIsGenerating(false)
        })
    }, 150) // debounce slider drags

    return () => clearTimeout(handle)
  }, [frameUrl, userImageUrl, targetKB, borderPercent])

  const steps = [
    { label: 'Frame', done: Boolean(frameUrl) },
    { label: 'Portrait', done: Boolean(userImageUrl) },
    { label: 'Combined', done: Boolean(combinedUrl) },
  ]

  return (
    <main className="min-h-screen px-4 py-10 sm:px-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-12">
          <p className="eyebrow mb-3">Decentralized Gentlemen Club</p>
          <h1 className="text-4xl sm:text-5xl text-ink-text mb-3">The Atelier</h1>
          <p className="text-ink-muted max-w-2xl">
            Generate a frame, set your portrait inside it, and export a JPEG sized for the chain.
            Output is 1024 × 1024, tuned to 200–400 KB.
          </p>

          <ol className="mt-6 flex flex-wrap gap-3 text-sm">
            {steps.map((step, i) => (
              <li
                key={step.label}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${
                  step.done ? 'border-gold text-gold bg-gold-soft' : 'border-ink-border text-ink-muted'
                }`}
              >
                <span className="font-display">{i + 1}</span>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-8">
            <FrameGenerator onFrameGenerated={setFrameUrl} />
            <ImageUploader onImageUploaded={setUserImageUrl} />
          </div>

          <div className="space-y-8">
            {combinedUrl ? (
              <>
                <OutputControls
                  targetKB={targetKB}
                  onTargetChange={setTargetKB}
                  borderPercent={borderPercent}
                  onBorderChange={setBorderPercent}
                  sizeBytes={sizeBytes}
                  inRange={inRange}
                  isGenerating={isGenerating}
                />
                <FinalImageDisplay imageUrl={combinedUrl} sizeBytes={sizeBytes} inRange={inRange} />
              </>
            ) : (
              <div className="card text-center py-16">
                <p className="font-display text-2xl text-ink-text mb-2">Awaiting the sitter</p>
                <p className="text-sm text-ink-muted">
                  {!frameUrl && !userImageUrl && 'Generate a frame and upload a portrait to begin.'}
                  {frameUrl && !userImageUrl && 'Frame ready. Upload a portrait to set inside it.'}
                  {!frameUrl && userImageUrl && 'Portrait ready. Generate a frame above.'}
                  {frameUrl && userImageUrl && isGenerating && 'Composing…'}
                </p>
                {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
              </div>
            )}
            {combinedUrl && error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        </div>
      </div>
    </main>
  )
}
