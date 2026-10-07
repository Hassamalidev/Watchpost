CREATE TABLE "status_notifications" (
	"subscriber_id" uuid NOT NULL,
	"update_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_notifications_subscriber_id_update_id_pk" PRIMARY KEY("subscriber_id","update_id")
);
--> statement-breakpoint
CREATE TABLE "status_subscribers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirm_token_hash" text,
	"confirm_sent_at" timestamp with time zone,
	"unsub_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_notifications" ADD CONSTRAINT "status_notifications_subscriber_id_status_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."status_subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_notifications" ADD CONSTRAINT "status_notifications_update_id_status_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."status_updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_subscribers" ADD CONSTRAINT "status_subscribers_page_id_status_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscribers_page_email_uq" ON "status_subscribers" USING btree ("page_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "status_subscribers_unsub_uq" ON "status_subscribers" USING btree ("unsub_token");--> statement-breakpoint
CREATE INDEX "status_subscribers_confirm_idx" ON "status_subscribers" USING btree ("confirm_token_hash") WHERE "status_subscribers"."confirm_token_hash" is not null;