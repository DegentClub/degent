const { classifyImage } = require('../../services/ai-client');
const logger = require('../../lib/logger');

async function classifyMedia(buffer, mimeType = 'image/jpeg') {
  try {
    const base64 = buffer.toString('base64');
    const result = await classifyImage(base64, mimeType);

    if (result.parsed) {
      logger.info({
        category: result.parsed.category,
        quality: result.parsed.quality_score,
      }, 'Image classified');
      return result.parsed;
    }

    // Fallback: couldn't parse AI response
    return {
      category: 'OTHER',
      quality_score: 30,
      description: 'Could not classify',
      suggested_tweet_text: null,
    };
  } catch (err) {
    logger.error({ err }, 'Image classification failed');
    return {
      category: 'OTHER',
      quality_score: 0,
      description: 'Classification error',
      suggested_tweet_text: null,
    };
  }
}

module.exports = { classifyMedia };
