CREATE TABLE "status_components" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"monitor_id" uuid,
	"manual_status" text,
	"group_name" text,
	"show_uptime" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"impact" text NOT NULL,
	"component_ids" jsonb NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"auto_monitor_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"domain_verified_at" timestamp with time zone,
	"domain_checked_at" timestamp with time zone,
	"domain_error" text,
	"branding" jsonb NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"settings" jsonb NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status_incident_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"ai_drafted" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_components" ADD CONSTRAINT "status_components_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_incidents" ADD CONSTRAINT "status_incidents_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_updates" ADD CONSTRAINT "status_updates_status_incident_id_status_incidents_id_fk" FOREIGN KEY ("status_incident_id") REFERENCES "public"."status_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_components_page_idx" ON "status_components" USING btree ("page_id","position");--> statement-breakpoint
CREATE INDEX "status_components_monitor_idx" ON "status_components" USING btree ("monitor_id") WHERE "status_components"."monitor_id" is not null;--> statement-breakpoint
CREATE INDEX "status_incidents_page_idx" ON "status_incidents" USING btree ("page_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "status_incidents_one_auto_uq" ON "status_incidents" USING btree ("page_id","auto_monitor_id") WHERE "status_incidents"."auto_monitor_id" is not null and "status_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_uq" ON "status_pages" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_custom_domain_uq" ON "status_pages" USING btree ("custom_domain") WHERE "status_pages"."custom_domain" is not null;--> statement-breakpoint
CREATE INDEX "status_pages_workspace_idx" ON "status_pages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "status_updates_incident_idx" ON "status_updates" USING btree ("status_incident_id","created_at");