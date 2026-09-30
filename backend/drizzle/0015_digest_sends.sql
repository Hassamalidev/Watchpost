CREATE TABLE "digest_sends" (
	"workspace_id" uuid NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_sends_workspace_id_week_start_pk" PRIMARY KEY("workspace_id","week_start")
);
