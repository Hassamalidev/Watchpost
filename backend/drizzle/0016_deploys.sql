CREATE TABLE "deploy_hooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"service" text,
	"version" text NOT NULL,
	"environment" text,
	"url" text,
	"description" text,
	"deployed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deploy_hooks" ADD CONSTRAINT "deploy_hooks_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_hooks_workspace_idx" ON "deploy_hooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_hooks_token_idx" ON "deploy_hooks" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "deploys_workspace_time_idx" ON "deploys" USING btree ("workspace_id","deployed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deploys_external_idx" ON "deploys" USING btree ("workspace_id","external_id") WHERE "deploys"."external_id" is not null;