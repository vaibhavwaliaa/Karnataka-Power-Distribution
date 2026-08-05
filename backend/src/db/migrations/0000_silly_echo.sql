CREATE TYPE "public"."fault_type" AS ENUM('span', 'dt', 'feeder', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."outage_scope" AS ENUM('feeder', 'dt');--> statement-breakpoint
CREATE TYPE "public"."pole_status" AS ENUM('live', 'dark', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."telemetry_event" AS ENUM('heartbeat', 'power_lost', 'power_restored', 'boot');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('detected', 'acknowledged', 'crew_assigned', 'resolved', 'verified', 'closed');--> statement-breakpoint
CREATE TYPE "public"."topology_source" AS ENUM('surveyed', 'inferred');--> statement-breakpoint
CREATE TABLE "pole_state" (
	"pole_id" varchar(32) PRIMARY KEY NOT NULL,
	"current_status" "pole_status" DEFAULT 'unknown' NOT NULL,
	"last_event_type" "telemetry_event",
	"last_event_ts" timestamp with time zone,
	"last_heartbeat_ts" timestamp with time zone,
	"last_seq" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poles" (
	"pole_id" varchar(32) PRIMARY KEY NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"feeder_id" varchar(32) NOT NULL,
	"dt_id" varchar(32) NOT NULL,
	"seq_on_line" integer,
	"parent_pole_id" varchar(32),
	"pole_type" varchar(32),
	"ward" varchar(16),
	"pincode" varchar(10),
	"device_id" varchar(64),
	"topology_source" "topology_source" DEFAULT 'surveyed' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_outages" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"scope" "outage_scope" NOT NULL,
	"target_id" varchar(32) NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "telemetry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"device_id" varchar(64) NOT NULL,
	"pole_id" varchar(32) NOT NULL,
	"event" "telemetry_event" NOT NULL,
	"energized" boolean NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"seq" bigint NOT NULL,
	"raw" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_affected_poles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_affected_poles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ticket_id" integer NOT NULL,
	"pole_id" varchar(32) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"fault_type" "fault_type" NOT NULL,
	"span_start_pole" varchar(32),
	"span_end_pole" varchar(32),
	"dt_id" varchar(32) NOT NULL,
	"feeder_id" varchar(32) NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"pincode" varchar(10),
	"affected_pole_count" integer DEFAULT 0 NOT NULL,
	"affected_households" integer DEFAULT 0,
	"confidence" double precision NOT NULL,
	"confidence_reason" text NOT NULL,
	"dispatch_brief" text,
	"status" "ticket_status" DEFAULT 'detected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"crew_assigned_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transformers" (
	"dt_id" varchar(32) PRIMARY KEY NOT NULL,
	"feeder_id" varchar(32) NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"capacity_kva" integer NOT NULL,
	"households_served" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_poles_dt" ON "poles" USING btree ("dt_id");--> statement-breakpoint
CREATE INDEX "idx_poles_feeder" ON "poles" USING btree ("feeder_id");--> statement-breakpoint
CREATE INDEX "idx_poles_device" ON "poles" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "idx_so_target" ON "scheduled_outages" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_so_time" ON "scheduled_outages" USING btree ("start","end");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_telemetry_dedup" ON "telemetry" USING btree ("device_id","seq");--> statement-breakpoint
CREATE INDEX "idx_telemetry_pole_ts" ON "telemetry" USING btree ("pole_id","ts");--> statement-breakpoint
CREATE INDEX "idx_tap_ticket" ON "ticket_affected_poles" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_tap_pole" ON "ticket_affected_poles" USING btree ("pole_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_status" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tickets_dt" ON "tickets" USING btree ("dt_id");