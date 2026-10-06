CREATE TABLE "rollups_1d" (
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"workspace_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"fail_count" integer NOT NULL,
	"ok_count" integer NOT NULL,
	"latency_sum" bigint NOT NULL,
	"latency_min" integer,
	"latency_max" integer,
	"histogram" integer[] NOT NULL,
	CONSTRAINT "rollups_1d_monitor_id_region_bucket_pk" PRIMARY KEY("monitor_id","region","bucket")
);
--> statement-breakpoint
CREATE TABLE "rollups_1h" (
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"workspace_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"fail_count" integer NOT NULL,
	"ok_count" integer NOT NULL,
	"latency_sum" bigint NOT NULL,
	"latency_min" integer,
	"latency_max" integer,
	"histogram" integer[] NOT NULL,
	CONSTRAINT "rollups_1h_monitor_id_region_bucket_pk" PRIMARY KEY("monitor_id","region","bucket")
);
--> statement-breakpoint
CREATE TABLE "rollups_5m" (
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"workspace_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"fail_count" integer NOT NULL,
	"ok_count" integer NOT NULL,
	"latency_sum" bigint NOT NULL,
	"latency_min" integer,
	"latency_max" integer,
	"histogram" integer[] NOT NULL,
	CONSTRAINT "rollups_5m_monitor_id_region_bucket_pk" PRIMARY KEY("monitor_id","region","bucket")
);
--> statement-breakpoint
CREATE INDEX "rollups_1d_bucket_idx" ON "rollups_1d" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "rollups_1h_bucket_idx" ON "rollups_1h" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "rollups_5m_bucket_idx" ON "rollups_5m" USING btree ("bucket");