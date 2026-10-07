ALTER TABLE "notification_deliveries" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "monitor_groups" ADD COLUMN "group_alerts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_deliveries_group_idx" ON "notification_deliveries" USING btree ("group_key","destination_key") WHERE "notification_deliveries"."group_key" is not null;--> statement-breakpoint
CREATE INDEX "incidents_suppressed_by_idx" ON "incidents" USING btree ("suppressed_by_incident_id") WHERE "incidents"."suppressed_by_incident_id" is not null;