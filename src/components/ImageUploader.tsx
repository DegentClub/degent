'use client'
import { useState, useRef } from 'react'

interface ImageUploaderProps {
  onImageUploaded: (url: string) => void
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export default function ImageUploader({ onImageUploaded }: ImageUploaderProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = (file: File) => {
    setError(null)
    if (!file.type.startsWith('image/')) {
      setError('That is not an image file.')
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('Image is larger than 20 MB.')
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const url = e.target?.result as string
      setImageUrl(url)
      onImageUploaded(url)
    }
    reader.readAsDataURL(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  const openPicker = () => fileInputRef.current?.click()

  return (
    <section className="card">
      <p className="eyebrow mb-1">Step two</p>
      <h2 className="text-2xl mb-4">Upload your portrait</h2>

      <div
        role="button"
        tabIndex={0}
        onClick={openPicker}
        onKeyDown={(e) => e.key === 'Enter' && openPicker()}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        className={`border border-dashed rounded-md p-8 text-center cursor-pointer transition-colors ${
          isDragging ? 'border-gold bg-gold-soft' : 'border-ink-border hover:border-gold/60'
        }`}
      >
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileInput} className="hidden" />

        {imageUrl ? (
          <div className="space-y-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
            <img src={imageUrl} alt="Uploaded portrait" className="max-w-full h-auto rounded-md mx-auto" style={{ maxHeight: 300 }} />
            <button
              onClick={(e) => {
                e.stopPropagation()
                openPicker()
              }}
              className="btn-ghost"
            >
              Change portrait
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="font-display text-xl text-ink-text">Drop an image here</p>
            <p className="text-sm text-ink-muted">or click to browse. Square images work best.</p>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  )
}
