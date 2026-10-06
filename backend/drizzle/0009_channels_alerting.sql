CREATE TABLE "alert_fallback_notices" (
	"workspace_id" uuid NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_fallback_notices_workspace_id_hour_start_pk" PRIMARY KEY("workspace_id","hour_start")
);
--> statement-breakpoint
CREATE TABLE "alert_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"destination_key" text NOT NULL,
	"channel_id" uuid,
	"kind" text NOT NULL,
	"actor_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config_enc" text NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_policies" ADD CONSTRAINT "alert_policies_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_refs" ADD CONSTRAINT "message_refs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_policies_one_default_uq" ON "alert_policies" USING btree ("workspace_id") WHERE "alert_policies"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_destination_uq" ON "notification_deliveries" USING btree ("event_key","destination_key");--> statement-breakpoint
CREATE INDEX "notification_deliveries_incident_idx" ON "notification_deliveries" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_unfinished_idx" ON "notification_deliveries" USING btree ("updated_at") WHERE "notification_deliveries"."status" in ('pending', 'sending', 'retrying');--> statement-breakpoint
CREATE INDEX "channels_workspace_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_refs_incident_channel_uq" ON "message_refs" USING btree ("incident_id","channel_id");