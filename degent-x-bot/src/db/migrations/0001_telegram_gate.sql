CREATE TABLE "gate_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"address" varchar(100) NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "gate_challenges_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "gate_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"address" varchar(100) NOT NULL,
	"degents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now(),
	"last_checked_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone,
	"invite_issued_at" timestamp with time zone,
	CONSTRAINT "gate_members_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "gate_members_address_unique" UNIQUE("address")
);
