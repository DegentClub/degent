import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
})

export async function POST(request: NextRequest) {
  try {
    const { description } = await request.json()
    
    if (!description) {
      return NextResponse.json(
        { error: 'Description is required' },
        { status: 400 }
      )
    }

    // Enhanced prompt for decorative frame generation
    const prompt = `${description}. Create a decorative picture frame border with ornate design. The CENTER must be TRANSPARENT or very light to allow an image to be placed behind it. Square 1:1 aspect ratio, artistic frame with elegant details. The frame should be a border around the edges, leaving the center open.`

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      size: '1024x1024',
      quality: 'standard',
      n: 1,
    })

    return NextResponse.json({ 
      imageUrl: response.data[0].url,
      revisedPrompt: response.data[0].revised_prompt 
    })
  } catch (error: any) {
    console.error('Error generating frame:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to generate frame' },
      { status: 500 }
    )
  }
}
