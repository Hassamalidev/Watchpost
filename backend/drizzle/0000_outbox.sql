CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "outbox_events_undispatched_idx" ON "outbox_events" USING btree ("created_at","id") WHERE "outbox_events"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_dispatched_at_idx" ON "outbox_events" USING btree ("dispatched_at") WHERE "outbox_events"."dispatched_at" is not null;