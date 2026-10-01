CREATE TABLE "credit_balances" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"included" integer DEFAULT 0 NOT NULL,
	"purchased" integer DEFAULT 0 NOT NULL,
	"grant_ref" text,
	"granted" integer DEFAULT 0 NOT NULL,
	"included_granted_at" timestamp with time zone,
	"included_expires_at" timestamp with time zone,
	"low_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_id" text NOT NULL,
	"incident_id" uuid,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_funding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"units" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"ref" text NOT NULL,
	"funded" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_balances" ADD CONSTRAINT "credit_balances_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_funding" ADD CONSTRAINT "provider_funding_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_ref_uq" ON "credit_ledger" USING btree ("workspace_id","reason","ref_id","bucket");--> statement-breakpoint
CREATE INDEX "credit_ledger_workspace_time_idx" ON "credit_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_incident_idx" ON "credit_ledger" USING btree ("incident_id") WHERE "credit_ledger"."incident_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_funding_ref_uq" ON "provider_funding" USING btree ("provider","ref");--> statement-breakpoint
CREATE INDEX "provider_funding_workspace_idx" ON "provider_funding" USING btree ("workspace_id","provider","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_ref_uq" ON "usage_ledger" USING btree ("provider","ref");--> statement-breakpoint
CREATE INDEX "usage_ledger_workspace_idx" ON "usage_ledger" USING btree ("workspace_id","provider","created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_provider_time_idx" ON "usage_ledger" USING btree ("provider","created_at");