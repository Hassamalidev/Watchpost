CREATE TABLE "inbound_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_sources" ADD CONSTRAINT "inbound_sources_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_sources_token_uq" ON "inbound_sources" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "inbound_sources_workspace_idx" ON "inbound_sources" USING btree ("workspace_id");