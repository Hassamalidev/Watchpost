CREATE TABLE "contact_methods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"verified_at" timestamp with time zone,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"code_send_count" integer DEFAULT 0 NOT NULL,
	"code_window_start" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"urgency" text NOT NULL,
	"delay_minutes" integer DEFAULT 0 NOT NULL,
	"contact_method_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_methods" ADD CONSTRAINT "contact_methods_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_contact_method_id_contact_methods_id_fk" FOREIGN KEY ("contact_method_id") REFERENCES "public"."contact_methods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_methods_user_address_uq" ON "contact_methods" USING btree ("workspace_id","user_id","type","address");--> statement-breakpoint
CREATE INDEX "contact_methods_user_idx" ON "contact_methods" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_rules_method_uq" ON "notification_rules" USING btree ("workspace_id","user_id","urgency","contact_method_id");