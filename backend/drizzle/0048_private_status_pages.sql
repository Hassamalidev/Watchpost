ALTER TABLE "status_pages" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;