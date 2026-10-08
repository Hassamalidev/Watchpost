CREATE TABLE "postmortems" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"markdown" text NOT NULL,
	"ai_generation_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;