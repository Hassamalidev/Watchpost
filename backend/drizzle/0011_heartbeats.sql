CREATE TABLE "heartbeat_pings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"excerpt" text
);
--> statement-breakpoint
CREATE TABLE "heartbeat_state" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"schedule" jsonb NOT NULL,
	"grace_seconds" integer NOT NULL,
	"max_duration_seconds" integer,
	"next_expected_at" timestamp with time zone,
	"running_since" timestamp with time zone,
	"last_ping_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_gaps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_ticks" (
	"source" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "heartbeat_pings_monitor_at_idx" ON "heartbeat_pings" USING btree ("monitor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_state_token_hash_uq" ON "heartbeat_state" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "heartbeat_state_due_idx" ON "heartbeat_state" USING btree ("next_expected_at") WHERE "heartbeat_state"."status" in ('up', 'degraded');--> statement-breakpoint
CREATE UNIQUE INDEX "platform_gaps_one_open_per_reason_uq" ON "platform_gaps" USING btree ("reason") WHERE "platform_gaps"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "platform_gaps_started_idx" ON "platform_gaps" USING btree ("started_at");