# AI Frame Generator & Image Combiner

## Overview
Next.js 14 app that:
1. Generates decorative frames using DALL-E 3
2. Uploads user images
3. Combines frame + image (1:1 aspect ratio)
4. Quality slider: adjusts file size between 200KB-400KB
5. Real-time file size measurement

## Tech Stack
- Next.js 14 + TypeScript + Tailwind CSS
- OpenAI DALL-E 3
- Canvas API for image processing
- Axios

## Key Features
- ✅ AI-generated decorative frames
- ✅ Image upload (drag & drop)
- ✅ Canvas-based image combination
- ✅ Quality slider (200-400KB range)
- ✅ Real-time size display
- ✅ 1:1 square output (1024x1024)
- ✅ Download final image

## Setup
```bash
npx create-next-app@14 ai-frame-combiner --typescript --tailwind --app
cd ai-frame-combiner
npm install openai@^4.20.0 axios@^1.6.0
```

## Environment Variables
```
OPENAI_API_KEY=your_key_here
```

## Project Structure
```
src/
├── app/
│   ├── api/generate-frame/route.ts  # Frame generation API
│   ├── page.tsx                     # Main page
│   └── layout.tsx
├── components/
│   ├── FrameGenerator.tsx           # Generate frame UI
│   ├── ImageUploader.tsx            # Upload image UI
│   ├── QualitySlider.tsx            # Size control slider
│   └── FinalImageDisplay.tsx        # Result display
└── lib/
    └── imageUtils.ts                # Image processing logic
```

## Core Implementation

### Image Utils (`src/lib/imageUtils.ts`)
```typescript
export async function combineImages(
  userImageUrl: string,
  frameImageUrl: string,
  quality: number = 0.92
): Promise<{ dataUrl: string; sizeKB: number }> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    canvas.width = 1024
    canvas.height = 1024

    const userImg = new Image()
    const frameImg = new Image()
    userImg.crossOrigin = 'anonymous'
    frameImg.crossOrigin = 'anonymous'

    let loaded = 0
    const checkLoad = () => {
      if (++loaded === 2) {
        ctx.drawImage(userImg, 0, 0, 1024, 1024)
        ctx.drawImage(frameImg, 0, 0, 1024, 1024)
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        const sizeKB = (dataUrl.length * 0.75) / 1024
        resolve({ dataUrl, sizeKB })
      }
    }

    userImg.onload = checkLoad
    frameImg.onload = checkLoad
    userImg.src = userImageUrl
    frameImg.src = frameImageUrl
  })
}
```

### Frame Generation API (`src/app/api/generate-frame/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: NextRequest) {
  const { description } = await request.json()
  
  const prompt = `${description}. Decorative picture frame border, ornate design, TRANSPARENT CENTER for image placement, square 1:1, artistic frame`

  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt,
    size: '1024x1024',
    quality: 'standard',
  })

  return NextResponse.json({ imageUrl: response.data[0].url })
}
```

### Main Page (`src/app/page.tsx`)
```typescript
'use client'
import { useState, useEffect } from 'react'
import { combineImages } from '@/lib/imageUtils'

export default function Home() {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [userImageUrl, setUserImageUrl] = useState<string | null>(null)
  const [combinedUrl, setCombinedUrl] = useState<string | null>(null)
  const [quality, setQuality] = useState(50) // 0-100
  const [sizeKB, setSizeKB] = useState(0)

  useEffect(() => {
    if (frameUrl && userImageUrl) {
      const q = 0.1 + (quality / 100) * 0.9
      combineImages(userImageUrl, frameUrl, q).then(result => {
        setCombinedUrl(result.dataUrl)
        setSizeKB(result.sizeKB)
      })
    }
  }, [frameUrl, userImageUrl, quality])

  return (
    <main className="p-8">
      <h1>🖼️ AI Frame Generator & Combiner</h1>
      {/* Add components here */}
    </main>
  )
}
```

## Quality Slider Logic
- Slider: 0-100 maps to target size 200-400KB
- Quality: 0.1-1.0 (JPEG compression)
- Formula: `quality = 0.1 + (sliderValue / 100) * 0.9`
- Real-time recombination on slider change

## Image Combination Flow
1. User generates frame with DALL-E 3
2. User uploads their image
3. Canvas draws user image (background)
4. Canvas draws frame (overlay)
5. Export as JPEG with quality setting
6. Calculate and display file size
7. Adjust quality slider to hit 200-400KB range

## Cost
- DALL-E 3: $0.04 per frame generation
- Image processing: Client-side (free)

## Next Steps
- Add Bitcoin Ordinals inscription
- Save generation history
- Multiple frame styles
- Batch processing
