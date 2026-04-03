const { generateTweet, generateReply, generateQuoteTweet, getContentTypeForTimeSlot } = require('./generator');
const { scoreCandidates, pickBest } = require('./scorer');
const prompts = require('./prompts');

module.exports = {
  generateTweet,
  generateReply,
  generateQuoteTweet,
  getContentTypeForTimeSlot,
  scoreCandidates,
  pickBest,
  prompts,
};
