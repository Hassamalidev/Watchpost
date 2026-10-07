CREATE TABLE "chat_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"external_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_links" ADD CONSTRAINT "chat_links_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_links_external_uq" ON "chat_links" USING btree ("workspace_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "chat_links_user_idx" ON "chat_links" USING btree ("workspace_id","user_id");