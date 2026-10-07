ALTER TABLE "notification_deliveries" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "contact_method_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "contact_type" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "contact_address" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "due_at" timestamp with time zone;