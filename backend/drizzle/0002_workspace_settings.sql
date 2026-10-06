CREATE TABLE "workspace_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"incident_seq" integer DEFAULT 0 NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;