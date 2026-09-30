CREATE TABLE "probe_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result_id" uuid,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" uuid,
	"secret_enc" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"last_heartbeat" jsonb,
	"quarantined_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "probes" ADD CONSTRAINT "probes_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "probe_tasks_dedupe_uq" ON "probe_tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "probe_tasks_pending_idx" ON "probe_tasks" USING btree ("region","created_at") WHERE "probe_tasks"."claimed_by" is null;