// Content generation prompt templates for each content type

const prompts = {
  meme: (context) => `Generate a viral meme tweet for @degentclub (Bitcoin Ordinals NFT collection).

Context:
- Bitcoin price: ${context.bitcoinPrice || 'unknown'}
- Trending topics: ${(context.recentTrending || []).join(', ') || 'none provided'}
- Recent top posts: ${(context.recentTopPosts || []).join(' | ') || 'none'}

Requirements:
- Must be funny, shareable, and culturally relevant to Bitcoin/crypto Twitter
- Degen slang is OK mid-sentence for flavor, but NEVER end a tweet with filler like 'wagmi', 'ser', 'fren', 'lfg', or 'based' — always end with a punchline, sharp observation, or mic-drop moment
- Reference Degent NFTs or Bitcoin Ordinals when natural
- Maximum 280 characters
- Include 0-2 hashtags max
- Make people want to RT this
- The last line of every tweet must HIT. No trailing slang. End strong.

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
STRICT: Each "text" MUST be 280 characters or less. Count carefully.`,

  alpha: (context) => `Generate an alpha/market commentary tweet for @degentclub.

Context:
- Bitcoin price: ${context.bitcoinPrice || 'unknown'}
- Recent mints: ${context.recentMints || 'unknown'}
- Floor price: ${context.floorPrice || 'unknown'}
- Market trends: ${(context.recentTrending || []).join(', ') || 'none'}

Requirements:
- Position Degent.Club as thought leaders in Bitcoin NFT space
- Mix conviction with data/observations
- Sound like a smart degen, not a corporate account
- Include "NFA" if making any market observations
- Subtle CTA to check out degent.club
- NEVER end a tweet with filler slang like 'wagmi', 'ser', 'fren' — end with insight or a sharp closer
- STRICT: Each tweet MUST be under 280 characters. Count carefully. No exceptions.
- Keep it punchy and concise — one sharp idea per tweet

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  engagement: (context) => `Generate an engagement-bait tweet for @degentclub to maximize replies and interaction.

Context:
- Time of day: ${context.timeSlot || 'unknown'}
- Recent community moments: ${(context.communityMoments || []).join(', ') || 'none'}

Requirements:
- Must drive replies, quotes, and likes
- Use formats: polls, questions, hot takes, "this or that", unpopular opinions
- Related to Bitcoin, NFTs, Ordinals, or degen culture
- Make people WANT to respond
- STRICT: Each tweet MUST be under 280 characters. Count carefully.

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  community: (context) => `Generate a community spotlight/holder appreciation tweet for @degentclub.

Context:
- Community highlights: ${(context.communityMoments || []).join(', ') || 'none'}
- Recent mints: ${context.recentMints || 'unknown'}

Requirements:
- Celebrate the community, holders, or a milestone
- Make holders feel proud and non-holders feel FOMO
- Can highlight mint milestones, community growth, or holder wins
- Warm but not cringe — confident community energy
- STRICT: Each tweet MUST be under 280 characters. Count carefully.

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  cta: (context) => `Generate a mint/buy call-to-action tweet for @degentclub.

Context:
- Mint link: degent.club
- Floor price: ${context.floorPrice || 'unknown'}
- Recent mints: ${context.recentMints || 'unknown'}
- Total supply minted: ${context.totalMinted || 'unknown'}

Requirements:
- Create FOMO, don't beg
- "Imagine not minting at these levels" energy
- Include degent.club link naturally
- Never sound desperate — sound like you're doing them a favor by telling them
- Must NOT include financial advice or price guarantees
- STRICT: Each tweet MUST be under 280 characters. Count carefully.

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  gm: (context) => `Generate a creative, unique "gm" tweet for @degentclub.

Context:
- Day of week: ${context.dayOfWeek || new Date().toLocaleDateString('en-US', { weekday: 'long' })}
- Bitcoin price: ${context.bitcoinPrice || 'unknown'}
- Trending: ${(context.recentTrending || []).join(', ') || 'nothing specific'}

Requirements:
- NOT a generic "gm" — must be creative, funny, or thought-provoking
- Can include a question to drive engagement
- Reference Bitcoin, Ordinals, Degents, or current events
- Set the tone for the day
- STRICT: Each tweet MUST be under 280 characters. Count carefully.

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  fomo: (context) => `Generate a FOMO-inducing closing tweet for @degentclub (evening/night post).

Context:
- Today's mints: ${context.recentMints || 'unknown'}
- Floor price movement: ${context.floorPrice || 'unknown'}
- Today's highlights: ${(context.communityMoments || []).join(', ') || 'none'}

Requirements:
- Create urgency without being desperate
- "While you were sleeping" or "Today's scoreboard" energy
- Hint at things happening behind the scenes
- Make people feel like they need to be paying attention
- STRICT: Each tweet MUST be under 280 characters. Count carefully.

Generate 3 candidate tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  reply: (context) => `Generate a reply to this tweet for @degentclub:

Original tweet by @${context.targetUsername}: "${context.targetTweetText}"

Requirements:
- Must be contextual to the original tweet
- Add value: humor, insight, or an interesting take
- Subtly reference Degent/Bitcoin NFTs when natural (don't force it)
- Never sycophantic — no "Great tweet!" energy
- Match the brand voice: confident, witty, degen-savvy
- STRICT: Each reply MUST be under 280 characters. Count carefully.

Generate 3 candidate replies as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,

  quoteTweet: (context) => `Generate a quote tweet for @degentclub about this tweet:

Original tweet by @${context.targetUsername}: "${context.targetTweetText}"

Requirements:
- Add your own take, don't just restate
- Connect it back to Degent/Bitcoin NFT narrative when possible
- Be witty, insightful, or funny
- Can agree, disagree, or riff on the original
- STRICT: Each quote tweet MUST be under 280 characters. Count carefully.

Generate 3 candidate quote tweets as JSON array: [{"text": "...", "score": 0-100}]
Each "text" value MUST be 280 characters or less.`,
};

module.exports = prompts;
