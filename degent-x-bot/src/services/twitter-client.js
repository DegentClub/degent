const { TwitterApi } = require('twitter-api-v2');
const config = require('../config');
const logger = require('../lib/logger');

let client = null;
let readOnlyClient = null;

function getTwitterClient() {
  if (!client) {
    client = new TwitterApi({
      appKey: config.twitter.apiKey,
      appSecret: config.twitter.apiSecret,
      accessToken: config.twitter.accessToken,
      accessSecret: config.twitter.accessTokenSecret,
    });
    logger.info('Twitter read-write client initialized');
  }
  return client;
}

function getReadOnlyClient() {
  if (!readOnlyClient) {
    readOnlyClient = new TwitterApi(config.twitter.bearerToken);
    logger.info('Twitter read-only client initialized');
  }
  return readOnlyClient;
}

// Post a tweet (text only or with media)
async function postTweet(text, options = {}) {
  const tw = getTwitterClient();
  try {
    const params = { text };
    if (options.mediaIds && options.mediaIds.length > 0) {
      params.media = { media_ids: options.mediaIds };
    }
    if (options.replyToTweetId) {
      params.reply = { in_reply_to_tweet_id: options.replyToTweetId };
    }
    if (options.quoteTweetId) {
      params.quote_tweet_id = options.quoteTweetId;
    }
    const result = await tw.v2.tweet(params);
    logger.info({ tweetId: result.data.id }, 'Tweet posted successfully');
    return result.data;
  } catch (err) {
    logger.error({ err, text }, 'Failed to post tweet');
    throw err;
  }
}

// Upload media (image buffer) and return media_id
async function uploadMedia(buffer, mimeType = 'image/jpeg') {
  const tw = getTwitterClient();
  try {
    const mediaId = await tw.v1.uploadMedia(buffer, { mimeType });
    logger.info({ mediaId }, 'Media uploaded successfully');
    return mediaId;
  } catch (err) {
    logger.error({ err }, 'Failed to upload media');
    throw err;
  }
}

// Post a thread (array of tweets)
async function postThread(tweets) {
  const tw = getTwitterClient();
  const posted = [];
  try {
    let lastTweetId = null;
    for (const tweet of tweets) {
      const params = { text: tweet.text };
      if (lastTweetId) {
        params.reply = { in_reply_to_tweet_id: lastTweetId };
      }
      if (tweet.mediaIds && tweet.mediaIds.length > 0) {
        params.media = { media_ids: tweet.mediaIds };
      }
      const result = await tw.v2.tweet(params);
      lastTweetId = result.data.id;
      posted.push(result.data);
    }
    logger.info({ count: posted.length }, 'Thread posted successfully');
    return posted;
  } catch (err) {
    logger.error({ err, posted: posted.length }, 'Thread posting failed mid-way');
    throw err;
  }
}

// Like a tweet
async function likeTweet(tweetId) {
  const tw = getTwitterClient();
  try {
    const me = await tw.v2.me();
    await tw.v2.like(me.data.id, tweetId);
    logger.info({ tweetId }, 'Tweet liked');
    return true;
  } catch (err) {
    logger.error({ err, tweetId }, 'Failed to like tweet');
    throw err;
  }
}

// Retweet
async function retweet(tweetId) {
  const tw = getTwitterClient();
  try {
    const me = await tw.v2.me();
    await tw.v2.retweet(me.data.id, tweetId);
    logger.info({ tweetId }, 'Retweeted');
    return true;
  } catch (err) {
    logger.error({ err, tweetId }, 'Failed to retweet');
    throw err;
  }
}

// Follow a user
async function followUser(userId) {
  const tw = getTwitterClient();
  try {
    const me = await tw.v2.me();
    await tw.v2.follow(me.data.id, userId);
    logger.info({ userId }, 'Followed user');
    return true;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to follow user');
    throw err;
  }
}

// Get user timeline tweets
async function getUserTimeline(userId, maxResults = 10) {
  const ro = getReadOnlyClient();
  try {
    const timeline = await ro.v2.userTimeline(userId, {
      max_results: maxResults,
      'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
    });
    return timeline.data?.data || [];
  } catch (err) {
    logger.error({ err, userId }, 'Failed to get user timeline');
    throw err;
  }
}

// Get tweet metrics
async function getTweetMetrics(tweetId) {
  const ro = getReadOnlyClient();
  try {
    const tweet = await ro.v2.singleTweet(tweetId, {
      'tweet.fields': ['public_metrics', 'organic_metrics', 'non_public_metrics'],
    });
    return tweet.data;
  } catch (err) {
    logger.error({ err, tweetId }, 'Failed to get tweet metrics');
    throw err;
  }
}

// Search recent tweets
async function searchRecentTweets(query, maxResults = 10) {
  const ro = getReadOnlyClient();
  try {
    const result = await ro.v2.search(query, {
      max_results: maxResults,
      'tweet.fields': ['created_at', 'public_metrics', 'author_id'],
      'user.fields': ['username', 'public_metrics'],
      expansions: ['author_id'],
    });
    return result;
  } catch (err) {
    logger.error({ err, query }, 'Failed to search tweets');
    throw err;
  }
}

// Get mentions
async function getMentions(maxResults = 10) {
  const tw = getTwitterClient();
  try {
    const me = await tw.v2.me();
    const mentions = await tw.v2.userMentionTimeline(me.data.id, {
      max_results: maxResults,
      'tweet.fields': ['created_at', 'public_metrics', 'author_id', 'conversation_id'],
    });
    return mentions.data?.data || [];
  } catch (err) {
    logger.error({ err }, 'Failed to get mentions');
    throw err;
  }
}

module.exports = {
  getTwitterClient,
  getReadOnlyClient,
  postTweet,
  uploadMedia,
  postThread,
  likeTweet,
  retweet,
  followUser,
  getUserTimeline,
  getTweetMetrics,
  searchRecentTweets,
  getMentions,
};
