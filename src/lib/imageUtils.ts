export async function combineImages(
  userImageUrl: string,
  frameImageUrl: string,
  quality: number = 0.92
): Promise<{ dataUrl: string; sizeKB: number }> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    
    if (!ctx) {
      reject(new Error('Could not get canvas context'))
      return
    }

    canvas.width = 1024
    canvas.height = 1024

    const userImg = new Image()
    const frameImg = new Image()
    // User image is a data URL, no CORS needed
    // Frame image is proxied through our server, no CORS needed

    let loaded = 0
    const checkLoad = () => {
      if (++loaded === 2) {
        try {
          // First, draw the frame as background
          ctx.drawImage(frameImg, 0, 0, 1024, 1024)
          
          // Calculate the inner area for the user image
          // Assume frame border is about 15% on each side (adjustable)
          const borderPercent = 0.15
          const innerSize = 1024 * (1 - 2 * borderPercent)
          const offset = 1024 * borderPercent
          
          // Draw user image in the center, scaled to fit the inner area
          ctx.drawImage(
            userImg,
            offset,
            offset,
            innerSize,
            innerSize
          )
          
          // Convert to JPEG with specified quality
          const dataUrl = canvas.toDataURL('image/jpeg', quality)
          
          // Calculate file size in KB
          // Base64 encoding increases size by ~33%, so we multiply by 0.75 to get actual size
          const sizeKB = Math.round((dataUrl.length * 0.75) / 1024)
          
          resolve({ dataUrl, sizeKB })
        } catch (error) {
          reject(error)
        }
      }
    }

    userImg.onerror = () => reject(new Error('Failed to load user image'))
    frameImg.onerror = () => reject(new Error('Failed to load frame image'))
    
    userImg.onload = checkLoad
    frameImg.onload = checkLoad
    
    userImg.src = userImageUrl
    frameImg.src = frameImageUrl
  })
}

export function downloadImage(dataUrl: string, filename: string = 'framed-image.jpg') {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}
