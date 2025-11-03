'use client'

interface QualitySliderProps {
  quality: number
  onQualityChange: (quality: number) => void
  sizeKB: number
  isGenerating: boolean
}

export default function QualitySlider({ 
  quality, 
  onQualityChange, 
  sizeKB,
  isGenerating 
}: QualitySliderProps) {
  // Calculate target size based on slider (200-400KB range)
  const targetSizeKB = 200 + (quality / 100) * 200

  // Determine if size is in optimal range
  const isInRange = sizeKB >= 200 && sizeKB <= 400
  const sizeColor = isInRange 
    ? 'text-green-600 dark:text-green-400' 
    : sizeKB < 200 
      ? 'text-orange-600 dark:text-orange-400' 
      : 'text-red-600 dark:text-red-400'

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6">
      <h2 className="text-2xl font-bold mb-4 text-gray-800 dark:text-white">
        ⚙️ Quality Settings
      </h2>

      <div className="space-y-4">
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Quality Level
            </label>
            <span className="text-sm text-gray-500 dark:text-gray-400">
              Target: {Math.round(targetSizeKB)}KB
            </span>
          </div>
          
          <input
            type="range"
            min="0"
            max="100"
            value={quality}
            onChange={(e) => onQualityChange(Number(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-purple-600"
            disabled={isGenerating}
          />
          
          <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span>Low (200KB)</span>
            <span>Medium (300KB)</span>
            <span>High (400KB)</span>
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Current File Size:
            </span>
            <span className={`text-lg font-bold ${sizeColor}`}>
              {isGenerating ? (
                <span className="text-gray-400">Calculating...</span>
              ) : (
                `${sizeKB} KB`
              )}
            </span>
          </div>
          
          {!isGenerating && (
            <div className="mt-2">
              {isInRange ? (
                <div className="flex items-center text-sm text-green-600 dark:text-green-400">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  Optimal size for Bitcoin Ordinals
                </div>
              ) : sizeKB < 200 ? (
                <div className="flex items-center text-sm text-orange-600 dark:text-orange-400">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  Increase quality for better detail
                </div>
              ) : (
                <div className="flex items-center text-sm text-red-600 dark:text-red-400">
                  <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                  Reduce quality to lower file size
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
