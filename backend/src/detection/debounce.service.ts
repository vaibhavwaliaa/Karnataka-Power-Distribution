import { db } from "../db/connection";
import { poles, poleState } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { runFaultDetection } from "./localizer.service";

// Debouncing service for telemetry bursts.
// When an outage happens, 30+ poles send signals almost at once.
// Instead of running fault detection 30 times, we wait a few seconds for the burst to settle and run it once per DT.

const debounceTimers = new Map<string, NodeJS.Timeout>();
const pendingChanges = new Map<string, Set<string>>();

// Schedules a debounced fault detection pass when a pole changes state.
export async function scheduleFaultDetection(
  poleId: string,
  newStatus: "live" | "dark"
): Promise<void> {
  // Look up which DT this pole belongs to
  const [pole] = await db
    .select({ dtId: poles.dtId })
    .from(poles)
    .where(eq(poles.poleId, poleId))
    .limit(1);

  if (!pole) return;

  const dtId = pole.dtId;

  // Track the change
  if (!pendingChanges.has(dtId)) {
    pendingChanges.set(dtId, new Set());
  }
  pendingChanges.get(dtId)!.add(poleId);

  // Reset the debounce timer for this DT
  if (debounceTimers.has(dtId)) {
    clearTimeout(debounceTimers.get(dtId)!);
  }

  debounceTimers.set(
    dtId,
    setTimeout(async () => {
      debounceTimers.delete(dtId);
      const changedPoles = pendingChanges.get(dtId);
      pendingChanges.delete(dtId);

      if (changedPoles && changedPoles.size > 0) {
        try {
          await runFaultDetection(dtId, changedPoles);
        } catch (err) {
          console.error(`[Debounce] Fault detection failed for DT ${dtId}:`, err);
        }
      }
    }, config.debounceWindowMs)
  );
}

/**
 * Force immediate fault detection (bypasses debounce). Used by simulator.
 */
export async function forceDetection(dtId: string): Promise<void> {
  // Cancel any pending debounce
  if (debounceTimers.has(dtId)) {
    clearTimeout(debounceTimers.get(dtId)!);
    debounceTimers.delete(dtId);
  }
  pendingChanges.delete(dtId);

  await runFaultDetection(dtId, new Set());
}
