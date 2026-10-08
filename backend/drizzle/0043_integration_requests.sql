CREATE TABLE "integration_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_requests" ADD CONSTRAINT "integration_requests_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_requests_name_idx" ON "integration_requests" USING btree ("name");--> statement-breakpoint
CREATE INDEX "integration_requests_workspace_idx" ON "integration_requests" USING btree ("workspace_id","created_at");