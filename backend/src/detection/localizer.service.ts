import { db } from "../db/connection";
import { poleState, tickets, ticketAffectedPoles, poles } from "../db/schema";
import { eq, inArray, and, isNull, not } from "drizzle-orm";
import {
  getCachedTree,
  getDTsForFeeder,
  getDownstreamPoles,
  countDownstream,
  type DTTree,
  type TreeNode,
} from "./topology.service";
import { isScheduledOutage } from "./outage-filter.service";
import { midpoint } from "../utils/haversine";
import { io } from "../index";

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface DetectedFault {
  faultType: "span" | "dt" | "feeder";
  /** Last live pole before the fault (null for DT/feeder faults) */
  spanStartPole: string | null;
  /** First dark pole after the fault (null for feeder faults) */
  spanEndPole: string | null;
  dtId: string;
  feederId: string;
  lat: number;
  lon: number;
  pincode: string | null;
  affectedPoleIds: string[];
  affectedPoleCount: number;
  affectedHouseholds: number;
  confidence: number;
  confidenceReason: string;
}

/* -------------------------------------------------------------------------- */
/*  Core fault detection — called per DT after debounce                        */
/* -------------------------------------------------------------------------- */

export async function runFaultDetection(
  dtId: string,
  _changedPoles: Set<string>
): Promise<void> {
  const tree = getCachedTree(dtId);
  if (!tree) {
    console.warn(`[Localizer] No tree for DT ${dtId}`);
    return;
  }

  // ---- Check for scheduled outage ----
  const { isScheduled, reason } = await isScheduledOutage(dtId, tree.feederId);
  if (isScheduled) {
    console.log(
      `[Localizer] DT ${dtId} under scheduled outage: ${reason}. Skipping.`
    );
    return;
  }

  // ---- Load current pole states from DB ----
  const poleIds = Array.from(tree.nodes.keys());
  if (poleIds.length === 0) return;

  const states = await db
    .select()
    .from(poleState)
    .where(inArray(poleState.poleId, poleIds));

  const stateMap = new Map<string, "live" | "dark" | "unknown">();
  for (const s of states) {
    stateMap.set(
      s.poleId,
      s.currentStatus as "live" | "dark" | "unknown"
    );
  }

  // For poles without devices (no state record), mark as "unknown"
  for (const poleId of poleIds) {
    if (!stateMap.has(poleId)) {
      stateMap.set(poleId, "unknown");
    }
  }

  // ---- Check for feeder-level fault first ----
  const feederFault = await checkFeederFault(tree.feederId, stateMap);
  if (feederFault) {
    await createTicketIfNew(feederFault);
    return; // Don't also create DT-level tickets
  }

  // ---- Check for DT-level fault ----
  const dtFault = checkDTFault(tree, stateMap);
  if (dtFault) {
    await createTicketIfNew(dtFault);
    return; // Don't also create span-level tickets
  }

  // ---- Find span faults (boundary detection) ----
  const spanFaults = findSpanFaults(tree, stateMap);
  for (const fault of spanFaults) {
    await createTicketIfNew(fault);
  }
}

/* -------------------------------------------------------------------------- */
/*  Feeder-level fault detection                                               */
/*  If every DT on a feeder shows "all dark", it's a feeder fault.            */
/* -------------------------------------------------------------------------- */

async function checkFeederFault(
  feederId: string,
  _stateMap: Map<string, "live" | "dark" | "unknown">
): Promise<DetectedFault | null> {
  const dtIds = getDTsForFeeder(feederId);
  if (dtIds.length < 2) return null; // Need multiple DTs to confirm feeder fault

  let allDTsDark = true;
  let totalAffected = 0;
  let totalHouseholds = 0;
  let sumLat = 0;
  let sumLon = 0;
  let pincodes: string[] = [];
  const allAffectedPoles: string[] = [];

  for (const dtId of dtIds) {
    const tree = getCachedTree(dtId);
    if (!tree) continue;

    // Load states for this DT
    const poleIds = Array.from(tree.nodes.keys());
    const states = await db
      .select()
      .from(poleState)
      .where(inArray(poleState.poleId, poleIds));

    const dtStateMap = new Map<string, string>();
    for (const s of states) {
      dtStateMap.set(s.poleId, s.currentStatus);
    }

    // Check if all poles in this DT are dark
    const hasLivePole = poleIds.some(
      (id) => dtStateMap.get(id) === "live"
    );

    if (hasLivePole) {
      allDTsDark = false;
      break;
    }

    totalAffected += poleIds.length;
    totalHouseholds += tree.householdsServed;
    sumLat += tree.dtLat;
    sumLon += tree.dtLon;
    allAffectedPoles.push(...poleIds);

    // Collect pincodes
    for (const [, node] of tree.nodes) {
      if (node.pincode) pincodes.push(node.pincode);
    }
  }

  if (!allDTsDark) return null;

  const avgLat = sumLat / dtIds.length;
  const avgLon = sumLon / dtIds.length;
  const mostCommonPincode = getMostCommon(pincodes);

  return {
    faultType: "feeder",
    spanStartPole: null,
    spanEndPole: null,
    dtId: dtIds[0],
    feederId,
    lat: avgLat,
    lon: avgLon,
    pincode: mostCommonPincode,
    affectedPoleIds: allAffectedPoles,
    affectedPoleCount: totalAffected,
    affectedHouseholds: totalHouseholds,
    confidence: 0.9,
    confidenceReason:
      `All ${dtIds.length} transformers on feeder ${feederId} are dark. ` +
      `This indicates a feeder-level fault (11 kV side or HT fuse).`,
  };
}

/* -------------------------------------------------------------------------- */
/*  DT-level fault detection                                                   */
/*  Every pole under this DT is dark, no live pole anywhere downstream.        */
/* -------------------------------------------------------------------------- */

function checkDTFault(
  tree: DTTree,
  stateMap: Map<string, "live" | "dark" | "unknown">
): DetectedFault | null {
  const poleIds = Array.from(tree.nodes.keys());
  if (poleIds.length === 0) return null;

  // Check if ANY pole is live
  const hasLivePole = poleIds.some((id) => stateMap.get(id) === "live");

  if (hasLivePole) return null; // Not a DT fault — some poles are live

  // All poles are dark or unknown — check if enough have devices to be confident
  const withDevices = poleIds.filter(
    (id) => tree.nodes.get(id)?.deviceId != null
  );
  const darkWithDevice = withDevices.filter(
    (id) => stateMap.get(id) === "dark"
  );

  // Need at least 3 poles with devices reporting dark to call a DT fault
  // (fewer could be coincident device failures)
  if (darkWithDevice.length < 3) return null;

  const pincodes = poleIds
    .map((id) => tree.nodes.get(id)?.pincode)
    .filter(Boolean) as string[];

  return {
    faultType: "dt",
    spanStartPole: null,
    spanEndPole: tree.rootPoles[0] || null,
    dtId: tree.dtId,
    feederId: tree.feederId,
    lat: tree.dtLat,
    lon: tree.dtLon,
    pincode: getMostCommon(pincodes),
    affectedPoleIds: poleIds,
    affectedPoleCount: poleIds.length,
    affectedHouseholds: tree.householdsServed,
    confidence: computeConfidence(tree, darkWithDevice.length, withDevices.length, true),
    confidenceReason:
      `All ${darkWithDevice.length} reporting poles under DT ${tree.dtId} are dark. ` +
      `No live pole found downstream. This indicates a DT fault ` +
      `(transformer failure, LT fuse, or DT-level disconnect). ` +
      `Topology: ${tree.topologySource}.`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Span fault detection — the core algorithm                                  */
/*                                                                             */
/*  Walk the tree from root. At each node:                                     */
/*  - If this node is live/unknown and a child is dark → FAULT on this edge    */
/*  - If this node is dark and has live children → DEAD SENSOR (not a fault)   */
/*  - Otherwise continue walking                                               */
/* -------------------------------------------------------------------------- */

function findSpanFaults(
  tree: DTTree,
  stateMap: Map<string, "live" | "dark" | "unknown">
): DetectedFault[] {
  const faults: DetectedFault[] = [];

  // Walk from each root pole
  for (const rootId of tree.rootPoles) {
    findFaultsRecursive(tree, rootId, stateMap, faults, "live");
  }

  return faults;
}

function findFaultsRecursive(
  tree: DTTree,
  poleId: string,
  stateMap: Map<string, "live" | "dark" | "unknown">,
  faults: DetectedFault[],
  parentStatus: "live" | "dark" | "unknown"
): void {
  const node = tree.nodes.get(poleId);
  if (!node) return;

  const myStatus = stateMap.get(poleId) || "unknown";

  // ---- Case 1: Dead sensor detection ----
  // A dark pole with live children is physically impossible as a line fault.
  // This is a dead sensor/device — log it, don't ticket it.
  if (myStatus === "dark" && node.children.length > 0) {
    const hasLiveChild = node.children.some(
      (childId) => stateMap.get(childId) === "live"
    );

    if (hasLiveChild) {
      // Dead sensor — skip this pole, continue walking children
      console.log(
        `[Localizer] Dead sensor detected at ${poleId} (dark pole with live children)`
      );
      for (const childId of node.children) {
        findFaultsRecursive(tree, childId, stateMap, faults, "live");
      }
      return;
    }
  }

  // ---- Case 2: Fault boundary ----
  // Parent is live (or this is a root) and this pole is dark
  // → fault on the edge between parent and this pole
  if (
    (parentStatus === "live" || parentStatus === "unknown") &&
    myStatus === "dark"
  ) {
    const parentNode =
      node.parent && node.parent !== tree.dtId
        ? tree.nodes.get(node.parent) || null
        : null;

    const affectedPoleIds = getDownstreamPoles(tree, poleId);
    const affectedCount = affectedPoleIds.length;

    // Compute fault location (midpoint of the faulted span)
    const faultLat = parentNode
      ? (parentNode.lat + node.lat) / 2
      : (tree.dtLat + node.lat) / 2;
    const faultLon = parentNode
      ? (parentNode.lon + node.lon) / 2
      : (tree.dtLon + node.lon) / 2;

    // Get pincode from the dark pole (more likely correct for dispatch)
    const pincode =
      node.pincode ||
      (parentNode?.pincode) ||
      null;

    // Count poles with devices in the affected area for confidence
    const withDevices = affectedPoleIds.filter(
      (id) => tree.nodes.get(id)?.deviceId != null
    ).length;

    const darkConfirmed = affectedPoleIds.filter(
      (id) => stateMap.get(id) === "dark"
    ).length;

    faults.push({
      faultType: "span",
      spanStartPole: node.parent !== tree.dtId ? node.parent : null,
      spanEndPole: poleId,
      dtId: tree.dtId,
      feederId: tree.feederId,
      lat: faultLat,
      lon: faultLon,
      pincode,
      affectedPoleIds,
      affectedPoleCount: affectedCount,
      affectedHouseholds: Math.round(
        (affectedCount / Math.max(tree.nodes.size, 1)) *
          tree.householdsServed
      ),
      confidence: computeConfidence(
        tree,
        darkConfirmed,
        withDevices,
        false
      ),
      confidenceReason: buildConfidenceReason(
        tree,
        node,
        parentNode,
        darkConfirmed,
        withDevices,
        affectedCount
      ),
    });

    // Don't recurse into the dark subtree — it's all one fault
    return;
  }

  // ---- Case 3: Continue walking ----
  for (const childId of node.children) {
    findFaultsRecursive(tree, childId, stateMap, faults, myStatus);
  }
}

/* -------------------------------------------------------------------------- */
/*  Confidence scoring                                                         */
/* -------------------------------------------------------------------------- */

function computeConfidence(
  tree: DTTree,
  darkConfirmed: number,
  totalWithDevices: number,
  isDTFault: boolean
): number {
  let confidence = 0.5; // Base

  // Topology confidence
  if (tree.topologySource === "surveyed") {
    confidence += 0.25;
  } else {
    confidence += 0.10; // Inferred topology is less certain
  }

  // Device coverage confidence
  if (totalWithDevices > 0) {
    const coverageRatio = darkConfirmed / totalWithDevices;
    confidence += coverageRatio * 0.15;
  }

  // DT faults with many confirming poles are higher confidence
  if (isDTFault && darkConfirmed >= 5) {
    confidence += 0.1;
  }

  return Math.min(0.99, Math.max(0.1, confidence));
}

function buildConfidenceReason(
  tree: DTTree,
  darkPole: TreeNode,
  livePole: TreeNode | null,
  darkConfirmed: number,
  withDevices: number,
  affectedCount: number
): string {
  const parts: string[] = [];

  parts.push(
    `Span fault detected between ${livePole ? livePole.poleId : "DT " + tree.dtId} (live) and ${darkPole.poleId} (dark).`
  );

  parts.push(`${affectedCount} poles affected downstream.`);

  if (tree.topologySource === "surveyed") {
    parts.push("Topology: surveyed (high confidence in boundary location).");
  } else {
    parts.push(
      "Topology: inferred from geometry (boundary position is estimated, not surveyed)."
    );
  }

  if (withDevices > 0) {
    parts.push(
      `${darkConfirmed}/${withDevices} instrumented poles in affected area confirmed dark.`
    );
  }

  if (!darkPole.deviceId) {
    parts.push(
      "Note: boundary pole has no device — actual fault may be on an adjacent span."
    );
  }

  return parts.join(" ");
}

/* -------------------------------------------------------------------------- */
/*  Ticket creation — dedup against existing open tickets                      */
/* -------------------------------------------------------------------------- */

async function createTicketIfNew(fault: DetectedFault): Promise<void> {
  // Check for existing open ticket covering the same area
  const existing = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.dtId, fault.dtId),
        eq(tickets.faultType, fault.faultType),
        // Only match open tickets
        not(eq(tickets.status, "closed")),
        not(eq(tickets.status, "verified"))
      )
    );

  // If there's already an open ticket for this DT with the same fault type,
  // don't create a duplicate
  if (existing.length > 0) {
    // Check if the existing ticket covers a similar area
    for (const ticket of existing) {
      if (
        fault.faultType === "dt" ||
        fault.faultType === "feeder" ||
        ticket.spanEndPole === fault.spanEndPole
      ) {
        console.log(
          `[Localizer] Ticket already exists for ${fault.faultType} fault at DT ${fault.dtId}`
        );
        return;
      }
    }
  }

  // Create the ticket
  const [newTicket] = await db
    .insert(tickets)
    .values({
      faultType: fault.faultType,
      spanStartPole: fault.spanStartPole,
      spanEndPole: fault.spanEndPole,
      dtId: fault.dtId,
      feederId: fault.feederId,
      lat: fault.lat,
      lon: fault.lon,
      pincode: fault.pincode,
      affectedPoleCount: fault.affectedPoleCount,
      affectedHouseholds: fault.affectedHouseholds,
      confidence: fault.confidence,
      confidenceReason: fault.confidenceReason,
      status: "detected",
    })
    .returning();

  // Store affected poles for restoration verification
  if (fault.affectedPoleIds.length > 0) {
    const affectedRecords = fault.affectedPoleIds.map((poleId) => ({
      ticketId: newTicket.id,
      poleId,
    }));

    const BATCH = 500;
    for (let i = 0; i < affectedRecords.length; i += BATCH) {
      await db
        .insert(ticketAffectedPoles)
        .values(affectedRecords.slice(i, i + BATCH));
    }
  }

  console.log(
    `[Localizer] Created ticket #${newTicket.id}: ${fault.faultType} fault at DT ${fault.dtId}` +
      (fault.spanStartPole
        ? ` (span: ${fault.spanStartPole} → ${fault.spanEndPole})`
        : "") +
      ` | ${fault.affectedPoleCount} poles | confidence: ${(fault.confidence * 100).toFixed(0)}%`
  );

  // Broadcast to connected clients
  io.emit("ticket:created", newTicket);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getMostCommon(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  let best = arr[0];
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}
