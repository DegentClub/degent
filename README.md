# 🖼️ AI Frame Generator & Image Combiner

A Next.js 14 application that generates decorative frames using DALL-E 3 AI and combines them with your images. Perfect for creating unique, framed artwork optimized for Bitcoin Ordinals inscriptions.

## ✨ Features

- **AI-Generated Frames**: Create custom decorative frames using DALL-E 3
- **Image Upload**: Drag & drop or browse to upload your images
- **Canvas-Based Combination**: Seamlessly combine frames with your images
- **Quality Control**: Adjust file size between 200-400KB with a slider
- **Real-Time Size Display**: See file size updates as you adjust quality
- **1:1 Square Output**: Perfect 1024x1024px images
- **Download**: Save your final framed images
- **Bitcoin Ordinals Ready**: Optimized file sizes for blockchain inscription

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ installed
- OpenAI API key

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd ai-app-2
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```bash
OPENAI_API_KEY=your_openai_api_key_here
```

4. Run the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser

## 📖 How to Use

1. **Generate a Frame**
   - Enter a description of your desired frame style (e.g., "Golden baroque frame with floral patterns")
   - Click "Generate Frame" and wait for DALL-E 3 to create your custom frame
   - Preview the generated frame

2. **Upload Your Image**
   - Drag and drop an image or click to browse
   - Your image will be displayed as a preview

3. **Adjust Quality**
   - Use the quality slider to adjust the file size between 200-400KB
   - The image will automatically regenerate with the new quality setting
   - Green indicator shows optimal size for Bitcoin Ordinals

4. **Download**
   - Click the "Download" button to save your framed image
   - Image will be saved as a JPEG file with timestamp

## 🛠️ Tech Stack

- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **AI**: OpenAI DALL-E 3
- **Image Processing**: HTML5 Canvas API
- **HTTP Client**: Axios

## 📁 Project Structure

```
src/
├── app/
│   ├── api/
│   │   └── generate-frame/
│   │       └── route.ts          # Frame generation API endpoint
│   ├── globals.css               # Global styles
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Main application page
├── components/
│   ├── FrameGenerator.tsx        # AI frame generation UI
│   ├── ImageUploader.tsx         # Image upload with drag & drop
│   ├── QualitySlider.tsx         # Quality control slider
│   └── FinalImageDisplay.tsx     # Final result display & download
└── lib/
    └── imageUtils.ts             # Image processing utilities
```

## 💰 Cost Considerations

- **DALL-E 3**: ~$0.04 per frame generation (standard quality, 1024x1024)
- **Image Processing**: Client-side (free)
- **Hosting**: Depends on your deployment platform

## 🔒 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | Your OpenAI API key | Yes |

## 🎨 Customization

### Frame Prompts
Edit the prompt in `src/app/api/generate-frame/route.ts` to customize how frames are generated:

```typescript
const prompt = `${description}. Create a decorative picture frame...`
```

### Quality Range
Adjust the quality range in `src/components/QualitySlider.tsx`:

```typescript
const targetSizeKB = 200 + (quality / 100) * 200 // Currently 200-400KB
```

### Canvas Size
Change the output dimensions in `src/lib/imageUtils.ts`:

```typescript
canvas.width = 1024  // Change to desired width
canvas.height = 1024 // Change to desired height
```

## 🐛 Troubleshooting

### CORS Issues with Images
If you encounter CORS errors, ensure the images have `crossOrigin = 'anonymous'` set (already configured in `imageUtils.ts`).

### Frame Generation Fails
- Check that your OpenAI API key is valid and has credits
- Verify the API key is properly set in `.env`
- Check the console for detailed error messages

### Image Won't Upload
- Ensure the file is a valid image format (JPEG, PNG, etc.)
- Check file size isn't too large (recommended < 10MB)

## 📝 License

MIT

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 🔮 Future Enhancements

- [ ] Add Bitcoin Ordinals inscription integration
- [ ] Save generation history
- [ ] Multiple frame style presets
- [ ] Batch processing for multiple images
- [ ] Custom canvas sizes
- [ ] PNG output option with transparency
- [ ] Frame style gallery

## 📧 Support

For issues and questions, please open an issue on GitHub.

---

Built with ❤️ using Next.js 14 and DALL-E 3
