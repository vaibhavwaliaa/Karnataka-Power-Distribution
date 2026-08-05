import {
  pgTable,
  varchar,
  doublePrecision,
  integer,
  boolean,
  timestamp,
  text,
  jsonb,
  bigint,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/*  Enums                                                              */
/* ------------------------------------------------------------------ */

export const topologySourceEnum = pgEnum("topology_source", [
  "surveyed",
  "inferred",
]);

export const telemetryEventEnum = pgEnum("telemetry_event", [
  "heartbeat",
  "power_lost",
  "power_restored",
  "boot",
]);

export const poleStatusEnum = pgEnum("pole_status", [
  "live",
  "dark",
  "unknown",
]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "detected",
  "acknowledged",
  "crew_assigned",
  "resolved",
  "verified",
  "closed",
]);

export const faultTypeEnum = pgEnum("fault_type", [
  "span",
  "dt",
  "feeder",
  "unknown",
]);

export const outageScope = pgEnum("outage_scope", ["feeder", "dt"]);

/* ------------------------------------------------------------------ */
/*  Tables                                                             */
/* ------------------------------------------------------------------ */

/** Distribution transformers (DTs) */
export const transformers = pgTable("transformers", {
  dtId: varchar("dt_id", { length: 32 }).primaryKey(),
  feederId: varchar("feeder_id", { length: 32 }).notNull(),
  lat: doublePrecision("lat").notNull(),
  lon: doublePrecision("lon").notNull(),
  capacityKva: integer("capacity_kva").notNull(),
  householdsServed: integer("households_served").notNull(),
});

/** LT poles */
export const poles = pgTable(
  "poles",
  {
    poleId: varchar("pole_id", { length: 32 }).primaryKey(),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    feederId: varchar("feeder_id", { length: 32 }).notNull(),
    dtId: varchar("dt_id", { length: 32 }).notNull(),
    seqOnLine: integer("seq_on_line"),
    parentPoleId: varchar("parent_pole_id", { length: 32 }),
    poleType: varchar("pole_type", { length: 32 }),
    ward: varchar("ward", { length: 16 }),
    pincode: varchar("pincode", { length: 10 }),
    deviceId: varchar("device_id", { length: 64 }),
    topologySource: topologySourceEnum("topology_source")
      .notNull()
      .default("surveyed"),
  },
  (table) => [
    index("idx_poles_dt").on(table.dtId),
    index("idx_poles_feeder").on(table.feederId),
    index("idx_poles_device").on(table.deviceId),
  ]
);

/** Raw telemetry from pole devices */
export const telemetry = pgTable(
  "telemetry",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    deviceId: varchar("device_id", { length: 64 }).notNull(),
    poleId: varchar("pole_id", { length: 32 }).notNull(),
    event: telemetryEventEnum("event").notNull(),
    energized: boolean("energized").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    raw: jsonb("raw"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_telemetry_dedup").on(table.deviceId, table.seq),
    index("idx_telemetry_pole_ts").on(table.poleId, table.ts),
  ]
);

/** Derived / materialized pole state — kept current as telemetry arrives */
export const poleState = pgTable("pole_state", {
  poleId: varchar("pole_id", { length: 32 }).primaryKey(),
  currentStatus: poleStatusEnum("current_status").notNull().default("unknown"),
  lastEventType: telemetryEventEnum("last_event_type"),
  lastEventTs: timestamp("last_event_ts", { withTimezone: true }),
  lastHeartbeatTs: timestamp("last_heartbeat_ts", { withTimezone: true }),
  lastSeq: bigint("last_seq", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Fault tickets */
export const tickets = pgTable(
  "tickets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    faultType: faultTypeEnum("fault_type").notNull(),
    spanStartPole: varchar("span_start_pole", { length: 32 }),
    spanEndPole: varchar("span_end_pole", { length: 32 }),
    dtId: varchar("dt_id", { length: 32 }).notNull(),
    feederId: varchar("feeder_id", { length: 32 }).notNull(),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    pincode: varchar("pincode", { length: 10 }),
    affectedPoleCount: integer("affected_pole_count").notNull().default(0),
    affectedHouseholds: integer("affected_households").default(0),
    confidence: doublePrecision("confidence").notNull(),
    confidenceReason: text("confidence_reason").notNull(),
    dispatchBrief: text("dispatch_brief"),
    status: ticketStatusEnum("status").notNull().default("detected"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    crewAssignedAt: timestamp("crew_assigned_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_tickets_status").on(table.status),
    index("idx_tickets_dt").on(table.dtId),
  ]
);

/** Affected poles linked to a ticket (for restoration verification) */
export const ticketAffectedPoles = pgTable(
  "ticket_affected_poles",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    ticketId: integer("ticket_id").notNull(),
    poleId: varchar("pole_id", { length: 32 }).notNull(),
  },
  (table) => [
    index("idx_tap_ticket").on(table.ticketId),
    index("idx_tap_pole").on(table.poleId),
  ]
);

/** Scheduled outages (load shedding, maintenance) */
export const scheduledOutages = pgTable(
  "scheduled_outages",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    scope: outageScope("scope").notNull(),
    targetId: varchar("target_id", { length: 32 }).notNull(),
    start: timestamp("start", { withTimezone: true }).notNull(),
    end: timestamp("end", { withTimezone: true }).notNull(),
    reason: text("reason"),
  },
  (table) => [
    index("idx_so_target").on(table.targetId),
    index("idx_so_time").on(table.start, table.end),
  ]
);

/* ------------------------------------------------------------------ */
/*  Type exports for use across the app                                */
/* ------------------------------------------------------------------ */

export type Pole = typeof poles.$inferSelect;
export type Transformer = typeof transformers.$inferSelect;
export type TelemetryRecord = typeof telemetry.$inferSelect;
export type PoleStateRecord = typeof poleState.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type ScheduledOutage = typeof scheduledOutages.$inferSelect;
