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
      setError('Please enter a frame description')
      return
    }

    setIsGenerating(true)
    setError(null)

    try {
      const response = await axios.post('/api/generate-frame', {
        description: description.trim()
      })

      const originalUrl = response.data.imageUrl
      // Proxy the image through our server to avoid CORS issues
      const proxiedUrl = `/api/proxy-image?url=${encodeURIComponent(originalUrl)}`
      setFrameUrl(proxiedUrl)
      onFrameGenerated(proxiedUrl)
    } catch (err: any) {
      console.error('Error generating frame:', err)
      setError(err.response?.data?.error || 'Failed to generate frame')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isGenerating) {
      generateFrame()
    }
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6">
      <h2 className="text-2xl font-bold mb-4 text-gray-800 dark:text-white">
        🎨 Generate AI Frame
      </h2>
      
      <div className="space-y-4">
        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Describe your frame style
          </label>
          <input
            id="description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="e.g., Golden baroque frame with floral patterns"
            className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
            disabled={isGenerating}
          />
        </div>

        <button
          onClick={generateFrame}
          disabled={isGenerating || !description.trim()}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold py-3 px-6 rounded-lg hover:from-purple-700 hover:to-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 transform hover:scale-105"
        >
          {isGenerating ? (
            <span className="flex items-center justify-center">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Generating Frame...
            </span>
          ) : (
            'Generate Frame'
          )}
        </button>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {frameUrl && (
          <div className="mt-4">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Generated Frame Preview:</p>
            <div className="relative rounded-lg overflow-hidden border-2 border-gray-200 dark:border-gray-700">
              <img 
                src={frameUrl} 
                alt="Generated frame" 
                className="w-full h-auto"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
