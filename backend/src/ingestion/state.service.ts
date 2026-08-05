import { db } from "../db/connection";
import { telemetry, poleState } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { scheduleFaultDetection } from "../detection/debounce.service";

// Telemetry processing service.
// Ingests incoming sensor packets, filters duplicates using sequence numbers, and triggers fault detection when pole state changes.

export interface TelemetryInput {
  device_id: string;
  pole_id: string;
  event: "heartbeat" | "power_lost" | "power_restored" | "boot";
  energized: boolean;
  ts: string;
  seq: number;
  battery_mv?: number;
  rssi?: number;
  fw?: string;
}

interface ProcessResult {
  accepted: number;
  duplicates: number;
  stale: number;
}

// In-memory cache for fast O(1) deduplication of sequence numbers per device.
// Avoids querying DB for every heartbeat packet.
const seqCache = new Map<string, number>();

// Processes a batch of telemetry messages from pole sensors.
export async function processTelemetry(
  messages: TelemetryInput[]
): Promise<ProcessResult> {
  let accepted = 0;
  let duplicates = 0;
  let stale = 0;

  for (const msg of messages) {
    const result = await processSingleMessage(msg);
    if (result === "accepted") accepted++;
    else if (result === "duplicate") duplicates++;
    else if (result === "stale") stale++;
  }

  return { accepted, duplicates, stale };
}

async function processSingleMessage(
  msg: TelemetryInput
): Promise<"accepted" | "duplicate" | "stale"> {
  const { device_id, pole_id, event, energized, ts, seq } = msg;

  // ---- Dedup check (in-memory fast path) ----
  const lastSeq = seqCache.get(device_id);
  if (lastSeq !== undefined && seq <= lastSeq && event !== "boot") {
    // seq resets on boot, so allow boot events through
    return "duplicate";
  }

  // ---- Stale message check ----
  const msgTime = new Date(ts).getTime();
  const now = Date.now();
  if (now - msgTime > config.staleMessageThresholdMs) {
    // Message is >6 hours old — log but don't act on it
    return "stale";
  }

  // ---- Persist to telemetry table ----
  try {
    await db.insert(telemetry).values({
      deviceId: device_id,
      poleId: pole_id,
      event,
      energized,
      ts: new Date(ts),
      seq,
      raw: msg as any,
    }).onConflictDoNothing(); // Dedup index catches anything the cache missed
  } catch (err: any) {
    // Unique violation = duplicate
    if (err.code === "23505") return "duplicate";
    throw err;
  }

  // ---- Update in-memory dedup cache ----
  if (event === "boot") {
    // Boot resets the sequence counter
    seqCache.set(device_id, seq);
  } else {
    seqCache.set(device_id, Math.max(lastSeq || 0, seq));
  }

  // ---- Update pole_state ----
  const newStatus = energized ? "live" : "dark";
  const previousState = await db
    .select()
    .from(poleState)
    .where(eq(poleState.poleId, pole_id))
    .limit(1);

  const prevStatus = previousState[0]?.currentStatus || "unknown";

  // Update the pole state
  await db
    .update(poleState)
    .set({
      currentStatus: newStatus,
      lastEventType: event,
      lastEventTs: new Date(ts),
      lastHeartbeatTs:
        event === "heartbeat" ? new Date(ts) : previousState[0]?.lastHeartbeatTs,
      lastSeq: seq,
      updatedAt: new Date(),
    })
    .where(eq(poleState.poleId, pole_id));

  // ---- Trigger fault detection if state changed ----
  if (prevStatus !== newStatus) {
    // State transition: schedule a fault detection pass for this pole's DT
    scheduleFaultDetection(pole_id, newStatus as "live" | "dark");
  }

  return "accepted";
}

/**
 * Get current state for a pole from the in-memory DB cache.
 */
export async function getPoleStatus(
  poleId: string
): Promise<"live" | "dark" | "unknown"> {
  const [state] = await db
    .select()
    .from(poleState)
    .where(eq(poleState.poleId, poleId))
    .limit(1);

  return (state?.currentStatus as "live" | "dark" | "unknown") || "unknown";
}
