CREATE TABLE "monitor_config_changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"monitor_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"op" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_tags" (
	"monitor_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "monitor_tags_monitor_id_tag_id_pk" PRIMARY KEY("monitor_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"secrets_enc" text,
	"interval_s" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"regions" text[] NOT NULL,
	"policies" jsonb NOT NULL,
	"severity" text NOT NULL,
	"alert_policy_id" uuid,
	"group_id" uuid,
	"parent_id" uuid,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"config_seq" bigint DEFAULT 0 NOT NULL,
	"runbook_url" text,
	"notes" text,
	"public_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_groups" ADD CONSTRAINT "monitor_groups_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_tags" ADD CONSTRAINT "monitor_tags_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_tags" ADD CONSTRAINT "monitor_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_group_id_monitor_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."monitor_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_parent_id_monitors_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_config_changes_monitor_idx" ON "monitor_config_changes" USING btree ("monitor_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_groups_workspace_name_uq" ON "monitor_groups" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "monitor_tags_tag_idx" ON "monitor_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "monitors_workspace_idx" ON "monitors" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "monitors_parent_idx" ON "monitors" USING btree ("parent_id") WHERE "monitors"."parent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_workspace_name_uq" ON "tags" USING btree ("workspace_id","name");