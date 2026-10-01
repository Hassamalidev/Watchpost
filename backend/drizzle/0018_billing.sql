CREATE TABLE "billing_accounts" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"effective_plan" text NOT NULL,
	"next_check_at" timestamp with time zone,
	"paddle_customer_id" text,
	"founding_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"paddle_subscription_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"paddle_subscription_id" text NOT NULL,
	"paddle_customer_id" text NOT NULL,
	"status" text NOT NULL,
	"plan_key" text NOT NULL,
	"billing_interval" text NOT NULL,
	"items" jsonb NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"paid_period_start" timestamp with time zone,
	"paid_period_end" timestamp with time zone,
	"scheduled_change" jsonb,
	"past_due_since" timestamp with time zone,
	"held_plan_key" text,
	"held_until" timestamp with time zone,
	"discount_id" text,
	"cancel_reason" text,
	"cancel_comment" text,
	"canceled_at" timestamp with time zone,
	"last_event_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trial_notices" (
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_notices_workspace_id_kind_pk" PRIMARY KEY("workspace_id","kind")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trial_notices" ADD CONSTRAINT "trial_notices_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_accounts_next_check_idx" ON "billing_accounts" USING btree ("next_check_at") WHERE "billing_accounts"."next_check_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_founding_uq" ON "billing_accounts" USING btree ("founding_number") WHERE "billing_accounts"."founding_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_event_id_uq" ON "billing_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "billing_events_unprocessed_idx" ON "billing_events" USING btree ("received_at") WHERE "billing_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_payments_transaction_uq" ON "subscription_payments" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "subscription_payments_subscription_idx" ON "subscription_payments" USING btree ("paddle_subscription_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_paddle_id_uq" ON "subscriptions" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_live_workspace_uq" ON "subscriptions" USING btree ("workspace_id") WHERE "subscriptions"."status" <> 'canceled';--> statement-breakpoint
CREATE INDEX "subscriptions_workspace_idx" ON "subscriptions" USING btree ("workspace_id","created_at");