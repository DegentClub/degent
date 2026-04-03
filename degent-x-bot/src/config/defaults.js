// Default bot configuration — stored in DB bot_config table
// These are the initial seed values

const defaultBotConfig = {
  posting: {
    min_posts_per_day: 5,
    max_posts_per_day: 10,
    min_gap_between_posts_minutes: 90,
    peak_hours_est: ['9-11', '12-14', '18-21'],
    timezone: 'America/New_York',
    auto_approve_content_types: ['meme', 'gm', 'engagement'],
    review_content_types: ['alpha', 'cta', 'controversy'],
  },
  engagement: {
    daily_like_budget: 75,
    daily_retweet_budget: 15,
    daily_reply_budget: 30,
    daily_follow_budget: 20,
    min_follower_count_to_engage: 100,
    engagement_cooldown_per_account_hours: 4,
  },
  telegram: {
    min_quality_score_to_post: 70,
    whale_alert_immediate_post: true,
    max_telegram_reposts_per_day: 5,
    credit_original_poster: true,
  },
  content: {
    content_mix: {
      meme: 0.35,
      alpha: 0.20,
      community: 0.15,
      cta: 0.10,
      engagement: 0.10,
      ecosystem: 0.10,
    },
    max_hashtags_per_tweet: 2,
    include_media_percentage: 0.80,
    thread_max_tweets: 7,
  },
  safety: {
    banned_words: ['financial advice', 'guaranteed returns', 'pump'],
    max_api_calls_per_15_min: 300,
    pause_on_rate_limit: true,
    auto_delete_flagged_content: false,
  },
};

module.exports = { defaultBotConfig };
