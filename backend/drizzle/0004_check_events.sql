CREATE TABLE "check_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"region" text,
	"error_code" text,
	"http_status" integer,
	"message" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE INDEX "check_events_monitor_at_idx" ON "check_events" USING btree ("monitor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "check_events_workspace_at_idx" ON "check_events" USING btree ("workspace_id","at" DESC NULLS LAST);