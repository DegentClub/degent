'use client'
import { useState } from 'react'
import axios from 'axios'

interface FrameGeneratorProps {
  onFrameGenerated: (url: string) => void
}

export default function FrameGenerator({ onFrameGenerated }: FrameGeneratorProps) {
  const [description, setDescription] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generateFrame = async () => {
    if (!description.trim()) {
      setError('Describe the frame first.')
      return
    }

    setIsGenerating(true)
    setError(null)

    try {
      const response = await axios.post('/api/generate-frame', {
        description: description.trim(),
      })

      const originalUrl: string = response.data.imageUrl
      // Same-origin proxy so the canvas is not tainted by the cross-origin image.
      const proxiedUrl = `/api/proxy-image?url=${encodeURIComponent(originalUrl)}`
      setFrameUrl(proxiedUrl)
      onFrameGenerated(proxiedUrl)
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error ?? err.message
        : 'Failed to generate frame'
      setError(message)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isGenerating) generateFrame()
  }

  return (
    <section className="card">
      <p className="eyebrow mb-1">Step one</p>
      <h2 className="text-2xl mb-4">Generate a frame</h2>

      <div className="space-y-4">
        <div>
          <label htmlFor="description" className="block text-sm text-ink-muted mb-2">
            Describe the frame
          </label>
          <input
            id="description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={400}
            placeholder="Gilded baroque frame, dark walnut, tarnished brass corners"
            className="w-full px-4 py-3 bg-ink border border-ink-border rounded-md text-ink-text placeholder:text-ink-muted/60 focus:outline-none focus:border-gold"
            disabled={isGenerating}
          />
        </div>

        <button onClick={generateFrame} disabled={isGenerating || !description.trim()} className="btn-primary w-full">
          {isGenerating ? 'Painting the frame…' : 'Generate frame'}
        </button>

        <p className="text-xs text-ink-muted">
          Each generation costs about <span className="text-btc">$0.04</span> in DALL·E credit.
        </p>

        {error && (
          <div className="border border-red-900/60 bg-red-950/30 text-red-300 px-4 py-3 rounded-md text-sm">{error}</div>
        )}

        {frameUrl && (
          <div>
            <p className="stat-label mb-2">Frame preview</p>
            <div className="rounded-md overflow-hidden border border-ink-border">
              {/* eslint-disable-next-line @next/next/no-img-element -- same-origin proxied blob, no optimisation wanted */}
              <img src={frameUrl} alt="Generated frame" className="w-full h-auto" />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
