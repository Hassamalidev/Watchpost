CREATE TABLE "escalations" (
	"incident_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_name" text NOT NULL,
	"steps" jsonb NOT NULL,
	"repeat" integer DEFAULT 0 NOT NULL,
	"next_step" integer DEFAULT 0 NOT NULL,
	"next_due_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"finished_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"repeat" integer DEFAULT 0 NOT NULL,
	"steps" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "escalations_unfinished_idx" ON "escalations" USING btree ("next_due_at") WHERE "escalations"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "escalation_policies_workspace_idx" ON "escalation_policies" USING btree ("workspace_id");