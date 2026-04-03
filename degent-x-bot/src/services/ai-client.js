const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../lib/logger');

let anthropic = null;
let openai = null;
let openrouter = null;

function getAnthropic() {
  if (!anthropic && config.ai.anthropicApiKey) {
    anthropic = new Anthropic({ apiKey: config.ai.anthropicApiKey });
  }
  return anthropic;
}

function getOpenAI() {
  if (!openai && config.ai.openaiApiKey) {
    openai = new OpenAI({ apiKey: config.ai.openaiApiKey });
  }
  return openai;
}

function getOpenRouter() {
  if (!openrouter && config.ai.openrouterKey) {
    openrouter = new OpenAI({
      apiKey: config.ai.openrouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://degent.club',
        'X-Title': 'DEGENT X BOT',
      },
    });
  }
  return openrouter;
}

// Map model names to OpenRouter format
function toOpenRouterModel(model) {
  const map = {
    'claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet',
    'claude-3-haiku-20240307': 'anthropic/claude-3-haiku',
    'gpt-4o': 'openai/gpt-4o',
    'gpt-4o-mini': 'openai/gpt-4o-mini',
  };
  return map[model] || model;
}

// Load the agent brain markdown (hot-reloadable)
function loadBrainPrompt() {
  const brainPaths = [
    path.join(__dirname, '../../brain/DEGENT_X_BOT_BRAIN.md'),
    path.join(__dirname, '../../../DEGENT_X_BOT_BRAIN.md'),
  ];
  for (const p of brainPaths) {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch (_) {
      // try next path
    }
  }
  logger.warn('Agent brain markdown not found, using fallback system prompt');
  return `You are DEGENT X BOT, the voice of @degentclub on Twitter/X. You are a confident, irreverent, Bitcoin-native meme lord and alpha caller for the Degent NFT collection on Bitcoin Ordinals. Your goal is to create viral content that drives minting at degent.club and builds the largest Bitcoin NFT community on X.`;
}

// Generate content using available AI providers
// Priority: OpenRouter → Anthropic (Claude) → OpenAI (GPT)
async function generateContent(userPrompt, options = {}) {
  const systemPrompt = loadBrainPrompt();
  const maxTokens = options.maxTokens || 1024;

  // Try OpenRouter first (supports all models via OpenAI-compatible API)
  const or = getOpenRouter();
  if (or) {
    try {
      const model = toOpenRouterModel(options.model || config.ai.primaryModel);
      const response = await or.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      const text = response.choices[0]?.message?.content || '';
      logger.info({ model, provider: 'openrouter' }, 'OpenRouter generation complete');
      return { text, model };
    } catch (err) {
      logger.error({ err }, 'OpenRouter generation failed, trying direct providers');
    }
  }

  // Try Claude directly
  const claude = getAnthropic();
  if (claude) {
    try {
      const response = await claude.messages.create({
        model: config.ai.primaryModel,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = response.content[0]?.text || '';
      logger.info({ model: config.ai.primaryModel, tokens: response.usage }, 'Claude generation complete');
      return { text, model: config.ai.primaryModel };
    } catch (err) {
      logger.error({ err }, 'Claude generation failed, trying fallback');
    }
  }

  // Fallback to GPT directly
  const gpt = getOpenAI();
  if (gpt) {
    try {
      const response = await gpt.chat.completions.create({
        model: config.ai.fallbackModel,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      const text = response.choices[0]?.message?.content || '';
      logger.info({ model: config.ai.fallbackModel }, 'GPT generation complete');
      return { text, model: config.ai.fallbackModel };
    } catch (err) {
      logger.error({ err }, 'GPT generation also failed');
      throw err;
    }
  }

  throw new Error('No AI provider available. Set OPENROUTER_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.');
}

// Generate JSON-structured content
async function generateJSON(userPrompt, options = {}) {
  const wrappedPrompt = `${userPrompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no code fences, no explanation.`;
  const result = await generateContent(wrappedPrompt, options);
  try {
    // Strip possible markdown code fences
    let cleaned = result.text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    result.parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err, raw: result.text }, 'Failed to parse AI JSON response');
    result.parsed = null;
  }
  return result;
}

// Classify an image using vision (Claude)
async function classifyImage(imageBase64, mimeType = 'image/jpeg', prompt) {
  // Try OpenRouter for vision, fall back to Anthropic direct
  const or = getOpenRouter();
  const claude = getAnthropic();
  if (!or && !claude) throw new Error('OpenRouter or Anthropic API key required for image classification');

  const defaultPrompt = `Analyze this image from the Degent NFT community Telegram group.

Classify it into one of these categories:
- MEME: Funny content, reaction images, market commentary memes
- FAN_ART: Original art featuring Degent characters or branding
- SCREENSHOT: Sales screenshots, floor price celebrations, whale alerts
- COMMUNITY: Group photos, event pics, IRL content
- TRAIT_SHOWCASE: Showing off rare or cool Degent traits
- SPAM: Irrelevant, low quality, or inappropriate content
- OTHER: Doesn't fit any category

Rate quality from 0-100 based on:
- Visual clarity and resolution (0-25)
- Relevance to Degent community (0-25)
- Viral/share potential for Twitter (0-25)
- Originality and creativity (0-25)

Return JSON: { "category": "...", "quality_score": 0, "description": "...", "suggested_tweet_text": "..." }`;

  try {
    let text = '';
    let usedModel = '';

    if (or) {
      // Use OpenRouter with vision-capable model
      const model = toOpenRouterModel(config.ai.primaryModel);
      const response = await or.chat.completions.create({
        model,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: prompt || defaultPrompt },
          ],
        }],
      });
      text = response.choices[0]?.message?.content || '';
      usedModel = model;
    } else {
      // Direct Anthropic
      const response = await claude.messages.create({
        model: config.ai.primaryModel,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: imageBase64 },
            },
            { type: 'text', text: prompt || defaultPrompt },
          ],
        }],
      });
      text = response.content[0]?.text || '';
      usedModel = config.ai.primaryModel;
    }

    let parsed = null;
    try {
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(cleaned);
    } catch (_) {
      logger.warn({ raw: text }, 'Could not parse image classification as JSON');
    }
    return { text, parsed, model: usedModel };
  } catch (err) {
    logger.error({ err }, 'Image classification failed');
    throw err;
  }
}

module.exports = {
  generateContent,
  generateJSON,
  classifyImage,
  loadBrainPrompt,
};
