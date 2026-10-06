CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"rrule" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"scope" jsonb NOT NULL,
	"suppress_alerts" boolean DEFAULT true NOT NULL,
	"show_on_pages" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"finished_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_windows_workspace_idx" ON "maintenance_windows" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_unfinished_idx" ON "maintenance_windows" USING btree ("finished_at");