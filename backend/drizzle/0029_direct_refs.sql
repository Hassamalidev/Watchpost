CREATE TABLE "direct_refs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"address" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "direct_refs" ADD CONSTRAINT "direct_refs_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "direct_refs_incident_address_uq" ON "direct_refs" USING btree ("incident_id","address");--> statement-breakpoint
CREATE INDEX "direct_refs_address_idx" ON "direct_refs" USING btree ("address","created_at");