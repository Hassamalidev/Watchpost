CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"bot_user_id" text,
	"bot_token_enc" text NOT NULL,
	"scopes" text NOT NULL,
	"installed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"link_token" text,
	"token_expires_at" timestamp with time zone,
	"chat_id" text,
	"chat_title" text,
	"linked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "backoff_ms" integer DEFAULT 8000 NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installations_workspace_team_uq" ON "slack_installations" USING btree ("workspace_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_chats_channel_uq" ON "telegram_chats" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_chats_link_token_uq" ON "telegram_chats" USING btree ("link_token");