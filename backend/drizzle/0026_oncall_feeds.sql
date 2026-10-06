CREATE TABLE "oncall_feeds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oncall_feeds" ADD CONSTRAINT "oncall_feeds_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oncall_feeds_user_uq" ON "oncall_feeds" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oncall_feeds_token_uq" ON "oncall_feeds" USING btree ("token_hash");