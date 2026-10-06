-- Custom migration: check_results partitioned by day on checked_at (PRODUCT.md §7.7, §8; D-035).
-- Drizzle can't declare partitioned tables; the query-only definition lives in
-- src/modules/results/schema/partitioned/check-results.ts. Partitions are maintained by the
-- results module's hourly job (3 days ahead, dropped after the 48 h raw retention).
CREATE TABLE "check_results" (
	"checked_at" timestamp with time zone NOT NULL,
	"id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"region" text NOT NULL,
	"probe_id" uuid,
	"ok" boolean NOT NULL,
	"error_code" text,
	"message" text,
	"http_status" integer,
	"latency_ms" integer NOT NULL,
	"timings" jsonb,
	"ip" text,
	"tls" jsonb,
	"details" jsonb,
	"task_id" uuid,
	"evidence_key" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_results_pkey" PRIMARY KEY ("checked_at", "id")
) PARTITION BY RANGE ("checked_at");
--> statement-breakpoint
CREATE INDEX "check_results_monitor_region_at_idx" ON "check_results" ("monitor_id", "region", "checked_at" DESC);
--> statement-breakpoint
DO $$
DECLARE
  day date;
BEGIN
  FOR day IN SELECT generate_series((now() AT TIME ZONE 'UTC')::date - 2, (now() AT TIME ZONE 'UTC')::date + 3, interval '1 day')::date LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF check_results FOR VALUES FROM (%L) TO (%L)',
      'check_results_p' || to_char(day, 'YYYYMMDD'),
      day::timestamp AT TIME ZONE 'UTC',
      (day + 1)::timestamp AT TIME ZONE 'UTC'
    );
  END LOOP;
END $$;
