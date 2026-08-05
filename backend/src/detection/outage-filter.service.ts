import { db } from "../db/connection";
import { scheduledOutages } from "../db/schema";
import { and, lte, gte } from "drizzle-orm";
import { config } from "../config";

/**
 * Check if a DT or feeder is currently under a scheduled outage.
 * Includes the buffer for overruns (scheduled outages often run 20-40 min late).
 */
export async function isScheduledOutage(
  dtId: string,
  feederId: string
): Promise<{ isScheduled: boolean; reason?: string }> {
  const now = new Date();

  // Check for outages covering this DT or its feeder
  const activeOutages = await db
    .select()
    .from(scheduledOutages)
    .where(
      and(
        lte(scheduledOutages.start, now),
        // end + buffer
        gte(
          scheduledOutages.end,
          new Date(now.getTime() - config.scheduledOutageBufferMs)
        )
      )
    );

  for (const outage of activeOutages) {
    if (outage.scope === "feeder" && outage.targetId === feederId) {
      return { isScheduled: true, reason: outage.reason || "Scheduled outage (feeder)" };
    }
    if (outage.scope === "dt" && outage.targetId === dtId) {
      return { isScheduled: true, reason: outage.reason || "Scheduled outage (DT)" };
    }
  }

  return { isScheduled: false };
}
