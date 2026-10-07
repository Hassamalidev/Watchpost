CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"ref_id" uuid NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"output" jsonb,
	"feedback" text,
	"feedback_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_generations_ref_idx" ON "ai_generations" USING btree ("workspace_id","kind","ref_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_generations_feedback_idx" ON "ai_generations" USING btree ("kind","prompt_version") WHERE "ai_generations"."feedback" is not null;