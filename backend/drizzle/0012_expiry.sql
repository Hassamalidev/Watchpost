CREATE TABLE "domain_expiry_cache" (
	"domain" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"registrar" text,
	"source" text,
	"error" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expiry_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"threshold" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rdap_bootstrap" (
	"tld" text PRIMARY KEY NOT NULL,
	"urls" text[] NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssl_state" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "incidents_one_open_per_monitor_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "expiry_notices_uq" ON "expiry_notices" USING btree ("monitor_id","kind","subject","threshold");--> statement-breakpoint
CREATE INDEX "ssl_state_workspace_idx" ON "ssl_state" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_monitor_uq" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."status" <> 'resolved' and "incidents"."monitor_id" is not null and "incidents"."source" <> 'expiry';