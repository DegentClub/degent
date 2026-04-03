CREATE TABLE "content_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" varchar(50) NOT NULL,
	"source" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"text_content" text,
	"media_urls" jsonb,
	"thread_tweets" jsonb,
	"telegram_message_id" bigint,
	"telegram_user" varchar(255),
	"telegram_username" varchar(255),
	"telegram_engagement_score" real,
	"scheduled_for" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"tweet_id" varchar(50),
	"tweet_url" text,
	"ai_model" varchar(50),
	"ai_prompt_used" text,
	"content_score" real,
	"approval_tier" varchar(20) DEFAULT 'auto',
	"approved_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "engagement_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_type" varchar(20) NOT NULL,
	"target_tweet_id" varchar(50),
	"target_user_id" varchar(50),
	"target_username" varchar(255),
	"response_text" text,
	"response_tweet_id" varchar(50),
	"engagement_tier" integer,
	"engagement_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tracked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitter_user_id" varchar(50) NOT NULL,
	"username" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"tier" integer DEFAULT 2 NOT NULL,
	"category" varchar(50),
	"last_engaged_at" timestamp with time zone,
	"total_engagements" integer DEFAULT 0,
	"engagement_frequency" varchar(20) DEFAULT 'daily',
	"is_active" boolean DEFAULT true,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "tracked_accounts_twitter_user_id_unique" UNIQUE("twitter_user_id")
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_queue_id" uuid,
	"tweet_id" varchar(50) NOT NULL,
	"impressions" bigint DEFAULT 0,
	"likes" integer DEFAULT 0,
	"retweets" integer DEFAULT 0,
	"replies" integer DEFAULT 0,
	"quote_tweets" integer DEFAULT 0,
	"bookmarks" integer DEFAULT 0,
	"link_clicks" integer DEFAULT 0,
	"profile_visits" integer DEFAULT 0,
	"engagement_rate" real DEFAULT 0,
	"metrics_1h" jsonb,
	"metrics_24h" jsonb,
	"metrics_7d" jsonb,
	"last_updated" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"posts_count" integer DEFAULT 0,
	"threads_count" integer DEFAULT 0,
	"telegram_reposts" integer DEFAULT 0,
	"likes_given" integer DEFAULT 0,
	"retweets_given" integer DEFAULT 0,
	"replies_given" integer DEFAULT 0,
	"follows_given" integer DEFAULT 0,
	"total_impressions" bigint DEFAULT 0,
	"total_likes" integer DEFAULT 0,
	"total_retweets" integer DEFAULT 0,
	"total_replies" integer DEFAULT 0,
	"follower_count" integer DEFAULT 0,
	"follower_delta" integer DEFAULT 0,
	"website_clicks" integer DEFAULT 0,
	"mints_attributed" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "daily_metrics_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "telegram_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_user_id" bigint,
	"telegram_username" varchar(255),
	"file_type" varchar(20) NOT NULL,
	"original_file_id" varchar(255),
	"stored_url" text,
	"thumbnail_url" text,
	"category" varchar(50),
	"quality_score" real,
	"reaction_count" integer DEFAULT 0,
	"forward_count" integer DEFAULT 0,
	"is_posted" boolean DEFAULT false,
	"content_queue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_config" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_content_queue_id_content_queue_id_fk" FOREIGN KEY ("content_queue_id") REFERENCES "public"."content_queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_media" ADD CONSTRAINT "telegram_media_content_queue_id_content_queue_id_fk" FOREIGN KEY ("content_queue_id") REFERENCES "public"."content_queue"("id") ON DELETE no action ON UPDATE no action;