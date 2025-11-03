'use client'
import { downloadImage } from '@/lib/imageUtils'

interface FinalImageDisplayProps {
  imageUrl: string
  sizeKB: number
}

export default function FinalImageDisplay({ imageUrl, sizeKB }: FinalImageDisplayProps) {
  const handleDownload = () => {
    const timestamp = new Date().getTime()
    downloadImage(imageUrl, `framed-image-${timestamp}.jpg`)
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white">
          ✨ Final Result
        </h2>
        <button
          onClick={handleDownload}
          className="bg-gradient-to-r from-green-600 to-emerald-600 text-white font-semibold py-2 px-4 rounded-lg hover:from-green-700 hover:to-emerald-700 transition-all duration-200 transform hover:scale-105 flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download
        </button>
      </div>

      <div className="space-y-4">
        <div className="relative rounded-lg overflow-hidden border-2 border-gray-200 dark:border-gray-700">
          <img
            src={imageUrl}
            alt="Combined frame and image"
            className="w-full h-auto"
          />
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <p className="text-gray-600 dark:text-gray-400 mb-1">Dimensions</p>
            <p className="font-semibold text-gray-800 dark:text-white">1024 × 1024 px</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <p className="text-gray-600 dark:text-gray-400 mb-1">File Size</p>
            <p className="font-semibold text-gray-800 dark:text-white">{sizeKB} KB</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <p className="text-gray-600 dark:text-gray-400 mb-1">Format</p>
            <p className="font-semibold text-gray-800 dark:text-white">JPEG</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <p className="text-gray-600 dark:text-gray-400 mb-1">Aspect Ratio</p>
            <p className="font-semibold text-gray-800 dark:text-white">1:1 Square</p>
          </div>
        </div>

        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <div className="flex items-start">
            <svg className="w-5 h-5 text-blue-600 dark:text-blue-400 mr-2 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
            <div className="text-sm text-blue-800 dark:text-blue-300">
              <p className="font-semibold mb-1">Ready for Bitcoin Ordinals</p>
              <p className="text-blue-700 dark:text-blue-400">
                This image is optimized for inscription on the Bitcoin blockchain. 
                Keep file size between 200-400KB for optimal inscription costs.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
