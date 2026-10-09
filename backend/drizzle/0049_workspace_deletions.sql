CREATE TABLE "workspace_deletions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"delete_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_erasures" (
	"erased_workspace_id" uuid PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"erased_at" timestamp with time zone NOT NULL,
	"objects" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_deletions" ADD CONSTRAINT "workspace_deletions_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_deletions_due_idx" ON "workspace_deletions" USING btree ("delete_after");