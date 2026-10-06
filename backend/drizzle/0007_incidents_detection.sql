CREATE TABLE "downtimes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"incident_id" uuid
);
--> statement-breakpoint
CREATE TABLE "monitor_region_state" (
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"status" text NOT NULL,
	"last_result_at" timestamp with time zone NOT NULL,
	"last_error_code" text,
	"last_latency_ms" integer,
	CONSTRAINT "monitor_region_state_monitor_id_region_pk" PRIMARY KEY("monitor_id","region")
);
--> statement-breakpoint
CREATE TABLE "monitor_state" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"open_incident_id" uuid,
	"last_result_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"verify_requested_at" timestamp with time zone,
	"state_changes" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"flapping_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"source" text NOT NULL,
	"monitor_id" uuid,
	"inbound_id" uuid,
	"dedup_key" text,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'triggered' NOT NULL,
	"cause_code" text,
	"failing_regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence" jsonb,
	"ai_summary" jsonb,
	"flapping" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"acked_at" timestamp with time zone,
	"acked_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"auto_resolved" boolean DEFAULT false NOT NULL,
	"false_alarm" boolean DEFAULT false NOT NULL,
	"escalation_policy_id" uuid,
	"esc_round" integer DEFAULT 0 NOT NULL,
	"esc_step" integer DEFAULT 0 NOT NULL,
	"snoozed_until" timestamp with time zone,
	"suppressed_by_incident_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "downtimes_monitor_started_idx" ON "downtimes" USING btree ("monitor_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "downtimes_one_open_per_monitor_uq" ON "downtimes" USING btree ("monitor_id") WHERE "downtimes"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "monitor_state_workspace_idx" ON "monitor_state" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "monitor_state_unevaluated_idx" ON "monitor_state" USING btree ("monitor_id") WHERE "monitor_state"."last_result_at" > coalesce("monitor_state"."last_evaluated_at", '-infinity'::timestamptz);--> statement-breakpoint
CREATE INDEX "incident_events_incident_at_idx" ON "incident_events" USING btree ("incident_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_monitor_uq" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."status" <> 'resolved' and "incidents"."monitor_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_dedup_uq" ON "incidents" USING btree ("workspace_id","dedup_key") WHERE "incidents"."status" <> 'resolved' and "incidents"."dedup_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_workspace_number_uq" ON "incidents" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "incidents_workspace_started_idx" ON "incidents" USING btree ("workspace_id","started_at" DESC NULLS LAST);