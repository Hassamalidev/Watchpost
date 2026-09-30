CREATE TABLE "action_tokens" (
	"nonce" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"action" text NOT NULL,
	"recipient" text NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	"used_by" uuid
);
--> statement-breakpoint
CREATE INDEX "action_tokens_incident_idx" ON "action_tokens" USING btree ("incident_id");