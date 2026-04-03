const { generateJSON, generateContent } = require('../../services/ai-client');
const { checkSafety } = require('../../lib/content-safety');
const { isDuplicate, recordContent } = require('../../lib/deduplicator');
const { scoreCandidates, pickBest } = require('./scorer');
const { getDb } = require('../../services/database');
const { contentQueue } = require('../../db/schema');
const prompts = require('./prompts');
const logger = require('../../lib/logger');

// Self-review: AI edits the tweet for quality before posting
async function reviewAndEdit(tweetText, contentType) {
  const reviewPrompt = `You are the quality editor for @DegentClub's Twitter account. Review this draft tweet and return an improved version.

DRAFT TWEET:
"${tweetText}"

CONTENT TYPE: ${contentType}

REVIEW CHECKLIST:
1. Does it end strong? The last line must be a punchline, insight, or mic-drop — NEVER trailing slang like "wagmi", "ser", "fren", "lfg", "based"
2. Is the voice right? Confident, witty, degen-savvy gentleman — not corporate, not try-hard
3. Is it under 280 characters? If not, trim it
4. Does it sound natural? Would a real person tweet this?
5. Is the humor/insight landing? Cut anything that falls flat
6. No emojis unless they genuinely add to the joke

Return ONLY the final tweet text. No quotes, no explanation, no JSON. Just the tweet ready to post.
If the draft is already great, return it unchanged.`;

  try {
    const result = await generateContent(reviewPrompt, { maxTokens: 512 });
    let reviewed = result.text.trim();
    // Strip any wrapping quotes the AI might add
    if ((reviewed.startsWith('"') && reviewed.endsWith('"')) || (reviewed.startsWith("'") && reviewed.endsWith("'"))) {
      reviewed = reviewed.slice(1, -1);
    }
    // Only use the reviewed version if it passes basic sanity checks
    if (reviewed.length > 0 && reviewed.length <= 280 && reviewed.length > 10) {
      logger.info({ original: tweetText.slice(0, 60), reviewed: reviewed.slice(0, 60) }, 'Tweet reviewed and edited');
      return reviewed;
    }
    logger.warn({ reviewedLength: reviewed.length }, 'Review returned bad output, using original');
    return tweetText;
  } catch (err) {
    logger.error({ err }, 'Tweet review failed, using original');
    return tweetText;
  }
}

// Generate content for a given type and context
async function generateTweet(contentType, context = {}) {
  const promptFn = prompts[contentType];
  if (!promptFn) {
    throw new Error(`Unknown content type: ${contentType}`);
  }

  const prompt = promptFn(context);
  logger.info({ contentType }, 'Generating content candidates');

  const result = await generateJSON(prompt, { maxTokens: 1024 });
  if (!result.parsed || !Array.isArray(result.parsed)) {
    logger.error({ raw: result.text }, 'AI did not return valid candidate array');
    // Try to extract a single tweet from the raw text
    return {
      text: result.text.slice(0, 280),
      score: 50,
      model: result.model,
      contentType,
      safetyCheck: checkSafety(result.text.slice(0, 280)),
    };
  }

  // Score all candidates
  const scored = scoreCandidates(result.parsed);
  const db = getDb();
  let winner = null;

  // Evaluate all candidates — save every one to DB
  for (const candidate of scored) {
    const safety = checkSafety(candidate.text);
    let rejectReason = null;

    if (!safety.pass) {
      rejectReason = `safety: ${safety.failures.join(', ')}`;
      logger.warn({ failures: safety.failures }, 'Candidate failed safety check');
    } else {
      const dupe = await isDuplicate(candidate.text);
      if (dupe) {
        rejectReason = 'duplicate';
        logger.warn('Candidate is duplicate, skipping');
      }
    }

    if (rejectReason) {
      // Save rejected candidate to DB for review
      await db.insert(contentQueue).values({
        contentType,
        source: 'ai_generated',
        status: 'rejected',
        textContent: candidate.text,
        aiModel: result.model,
        aiPromptUsed: prompt,
        contentScore: candidate.score,
        approvalTier: 'auto',
      }).catch(err => logger.error({ err }, 'Failed to save rejected candidate'));
      continue;
    }

    // First passing candidate is the winner — self-review it
    if (!winner) {
      const reviewedText = await reviewAndEdit(candidate.text, contentType);

      // Re-check safety after review edit
      const reviewedSafety = checkSafety(reviewedText);
      if (!reviewedSafety.pass) {
        logger.warn({ failures: reviewedSafety.failures }, 'Reviewed tweet failed safety, using original');
      }

      const finalText = reviewedSafety.pass ? reviewedText : candidate.text;

      winner = {
        text: finalText,
        score: candidate.score,
        isThread: candidate.isThread || false,
        model: result.model,
        contentType,
        prompt,
        safetyCheck: reviewedSafety.pass ? reviewedSafety : safety,
      };
    } else {
      // Save runner-up candidates as drafts for potential manual use
      await db.insert(contentQueue).values({
        contentType,
        source: 'ai_generated',
        status: 'draft',
        textContent: candidate.text,
        aiModel: result.model,
        aiPromptUsed: prompt,
        contentScore: candidate.score,
        approvalTier: 'review',
      }).catch(err => logger.error({ err }, 'Failed to save draft candidate'));
    }
  }

  if (winner) {
    logger.info({ contentType, score: winner.score }, 'Best candidate selected after review');
    return winner;
  }

  // If all candidates failed, return null
  logger.warn({ contentType }, 'All candidates failed safety/dedup checks');
  return null;
}

// Generate a reply to a specific tweet
async function generateReply(targetUsername, targetTweetText) {
  return generateTweet('reply', { targetUsername, targetTweetText });
}

// Generate a quote tweet
async function generateQuoteTweet(targetUsername, targetTweetText) {
  return generateTweet('quoteTweet', { targetUsername, targetTweetText });
}

// Determine the content type for the current time slot
function getContentTypeForTimeSlot() {
  const hour = new Date().getUTCHours() - 4; // EST offset (simplified)
  const estHour = hour < 0 ? hour + 24 : hour;

  if (estHour >= 6 && estHour < 8) return 'gm';
  if (estHour >= 9 && estHour < 11) return 'alpha';
  if (estHour >= 12 && estHour < 13) return 'meme';
  if (estHour >= 14 && estHour < 16) return 'community';
  if (estHour >= 18 && estHour < 20) return 'engagement';
  if (estHour >= 21 && estHour < 23) return 'fomo';

  // Default: weighted random based on content mix
  const types = ['meme', 'meme', 'meme', 'alpha', 'alpha', 'community', 'cta', 'engagement', 'gm'];
  return types[Math.floor(Math.random() * types.length)];
}

module.exports = {
  generateTweet,
  generateReply,
  generateQuoteTweet,
  getContentTypeForTimeSlot,
};
