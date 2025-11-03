'use client'
import { useState, useEffect } from 'react'
import { combineImages } from '@/lib/imageUtils'
import FrameGenerator from '@/components/FrameGenerator'
import ImageUploader from '@/components/ImageUploader'
import QualitySlider from '@/components/QualitySlider'
import FinalImageDisplay from '@/components/FinalImageDisplay'

export default function Home() {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [userImageUrl, setUserImageUrl] = useState<string | null>(null)
  const [combinedUrl, setCombinedUrl] = useState<string | null>(null)
  const [quality, setQuality] = useState(50) // 0-100 slider value
  const [sizeKB, setSizeKB] = useState(0)
  const [isGenerating, setIsGenerating] = useState(false)

  useEffect(() => {
    console.log('Frame URL:', frameUrl ? 'Set' : 'Not set')
    console.log('User Image URL:', userImageUrl ? 'Set' : 'Not set')
    
    if (frameUrl && userImageUrl) {
      console.log('Starting image combination...')
      setIsGenerating(true)
      // Map slider value (0-100) to quality (0.1-1.0)
      const q = 0.1 + (quality / 100) * 0.9
      combineImages(userImageUrl, frameUrl, q).then(result => {
        console.log('Image combination successful! Size:', result.sizeKB, 'KB')
        setCombinedUrl(result.dataUrl)
        setSizeKB(result.sizeKB)
        setIsGenerating(false)
      }).catch(error => {
        console.error('Error combining images:', error)
        setIsGenerating(false)
      })
    }
  }, [frameUrl, userImageUrl, quality])

  return (
    <main className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 dark:from-gray-900 dark:to-gray-800 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
            🖼️ AI Frame Generator & Combiner
          </h1>
          <p className="text-gray-600 dark:text-gray-300 text-lg">
            Generate decorative frames with AI and combine them with your images
          </p>
          
          {/* Progress Indicator */}
          <div className="mt-6 flex items-center justify-center gap-4 text-sm">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full ${
              frameUrl ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
            }`}>
              {frameUrl ? '✓' : '1'} Frame Generated
            </div>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full ${
              userImageUrl ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
            }`}>
              {userImageUrl ? '✓' : '2'} Image Uploaded
            </div>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full ${
              combinedUrl ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
            }`}>
              {combinedUrl ? '✓' : '3'} Combined
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Left Column: Frame Generator & Image Uploader */}
          <div className="space-y-8">
            <FrameGenerator onFrameGenerated={setFrameUrl} />
            <ImageUploader onImageUploaded={setUserImageUrl} />
          </div>

          {/* Right Column: Combined Result */}
          <div className="space-y-8">
            {combinedUrl && (
              <>
                <QualitySlider 
                  quality={quality} 
                  onQualityChange={setQuality}
                  sizeKB={sizeKB}
                  isGenerating={isGenerating}
                />
                <FinalImageDisplay 
                  imageUrl={combinedUrl} 
                  sizeKB={sizeKB}
                />
              </>
            )}
            {!combinedUrl && (
              <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 text-center">
                <div className="text-gray-400 dark:text-gray-500">
                  <svg className="w-24 h-24 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <p className="text-lg font-semibold mb-2">Waiting for images...</p>
                  <div className="text-left max-w-md mx-auto space-y-2">
                    {!frameUrl && !userImageUrl && (
                      <p className="text-sm">👈 Start by generating a frame and uploading an image on the left</p>
                    )}
                    {frameUrl && !userImageUrl && (
                      <p className="text-sm">✅ Frame ready! Now scroll down on the left to upload your image</p>
                    )}
                    {!frameUrl && userImageUrl && (
                      <p className="text-sm">✅ Image ready! Now generate a frame above</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
