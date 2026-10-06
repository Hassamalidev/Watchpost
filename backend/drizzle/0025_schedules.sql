CREATE TABLE "schedule_layers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"rotation" text NOT NULL,
	"shift_hours" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"participants" jsonb NOT NULL,
	"restrictions" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_layers" ADD CONSTRAINT "schedule_layers_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_layers" ADD CONSTRAINT "schedule_layers_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_overrides" ADD CONSTRAINT "schedule_overrides_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_overrides" ADD CONSTRAINT "schedule_overrides_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_layers_schedule_idx" ON "schedule_layers" USING btree ("schedule_id","position");--> statement-breakpoint
CREATE INDEX "schedule_overrides_schedule_idx" ON "schedule_overrides" USING btree ("schedule_id","ends_at");--> statement-breakpoint
CREATE INDEX "schedules_workspace_idx" ON "schedules" USING btree ("workspace_id");