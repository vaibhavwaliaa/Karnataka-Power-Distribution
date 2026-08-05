// Core fault detection logic (pure functions, easy to unit test without DB).
// Took help from AI to structure the recursive boundary search and dead-sensor filtering edge cases.

import type { DTTree, TreeNode } from "./topology.service";
import { getDownstreamPoles } from "./topology.service";

export interface DetectedFault {
  faultType: "span" | "dt" | "feeder";
  spanStartPole: string | null;
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

export type PoleStatus = "live" | "dark" | "unknown";

// Checks if the entire transformer (DT) has gone dark.
// If every pole under this DT is dark and at least 3 devices confirm it, it's a DT-level fault (blown LT fuse or transformer failure).
export function checkDTFault(
  tree: DTTree,
  stateMap: Map<string, PoleStatus>
): DetectedFault | null {
  const poleIds = Array.from(tree.nodes.keys());
  if (poleIds.length === 0) return null;

  const hasLivePole = poleIds.some((id) => stateMap.get(id) === "live");
  if (hasLivePole) return null;

  const withDevices = poleIds.filter(
    (id) => tree.nodes.get(id)?.deviceId != null
  );
  const darkWithDevice = withDevices.filter(
    (id) => stateMap.get(id) === "dark"
  );

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
    confidence: computeConfidence(
      tree,
      darkWithDevice.length,
      withDevices.length,
      true
    ),
    confidenceReason:
      `All ${darkWithDevice.length} reporting poles under DT ${tree.dtId} are dark. ` +
      `No live pole found downstream. This indicates a DT fault ` +
      `(transformer failure, LT fuse, or DT-level disconnect). ` +
      `Topology: ${tree.topologySource}.`,
  };
}

// Span fault detection: finding the live-to-dark boundary on the line.
// We recursively walk down the DT tree starting from the root poles.
export function findSpanFaults(
  tree: DTTree,
  stateMap: Map<string, PoleStatus>
): DetectedFault[] {
  const faults: DetectedFault[] = [];

  for (const rootId of tree.rootPoles) {
    findFaultsRecursive(tree, rootId, stateMap, faults, "live");
  }

  return faults;
}

function findFaultsRecursive(
  tree: DTTree,
  poleId: string,
  stateMap: Map<string, PoleStatus>,
  faults: DetectedFault[],
  parentStatus: PoleStatus
): void {
  const node = tree.nodes.get(poleId);
  if (!node) return;

  const myStatus = stateMap.get(poleId) || "unknown";

  // ---- Case 1: Dead sensor detection ----
  // A dark pole with live children is physically impossible as a line fault.
  if (myStatus === "dark" && node.children.length > 0) {
    const hasLiveChild = node.children.some(
      (childId) => stateMap.get(childId) === "live"
    );

    if (hasLiveChild) {
      // Dead sensor check: If this pole says dark but any child below it is live, 
      // it's physically impossible for the main line to be cut here.
      // So we ignore this bad sensor and keep checking the children.
      for (const childId of node.children) {
        findFaultsRecursive(tree, childId, stateMap, faults, "live");
      }
      return;
    }
  }

  // Live-to-dark frontier found!
  // Parent is live but this pole is dark => wire snapped on the span between them.
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

    // Calculate midpoint of the span for GPS dispatch navigation
    const faultLat = parentNode
      ? (parentNode.lat + node.lat) / 2
      : (tree.dtLat + node.lat) / 2;
    const faultLon = parentNode
      ? (parentNode.lon + node.lon) / 2
      : (tree.dtLon + node.lon) / 2;

    const pincode = node.pincode || parentNode?.pincode || null;

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
      confidence: computeConfidence(tree, darkConfirmed, withDevices, false),
      confidenceReason: buildConfidenceReason(
        tree,
        node,
        parentNode,
        darkConfirmed,
        withDevices,
        affectedCount
      ),
    });

    // We stop recursing here because everything below is part of this same fault ticket
    return;
  }

  // Keep traversing downstream
  for (const childId of node.children) {
    findFaultsRecursive(tree, childId, stateMap, faults, myStatus);
  }
}

// Confidence score formula:
// Surveyed topology gives higher baseline confidence (+0.25) vs geometric MST (+0.10).
// More dark devices confirming downstream adds to confidence.
export function computeConfidence(
  tree: DTTree,
  darkConfirmed: number,
  totalWithDevices: number,
  isDTFault: boolean
): number {
  let confidence = 0.5;

  if (tree.topologySource === "surveyed") {
    confidence += 0.25;
  } else {
    confidence += 0.10;
  }

  if (totalWithDevices > 0) {
    const coverageRatio = darkConfirmed / totalWithDevices;
    confidence += coverageRatio * 0.15;
  }

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
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function getMostCommon(arr: string[]): string | null {
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
