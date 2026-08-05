import { db } from "../db/connection";
import { poles, transformers } from "../db/schema";
import { eq } from "drizzle-orm";
import { haversineDistance } from "../utils/haversine";
import type { Pole, Transformer } from "../db/schema";

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface TreeNode {
  poleId: string;
  lat: number;
  lon: number;
  dtId: string;
  feederId: string;
  ward: string | null;
  pincode: string | null;
  deviceId: string | null;
  topologySource: "surveyed" | "inferred";
  parent: string | null; // poleId or dtId for root poles
  children: string[];
  depth: number;
}

export interface DTTree {
  dtId: string;
  feederId: string;
  dtLat: number;
  dtLon: number;
  householdsServed: number;
  topologySource: "surveyed" | "inferred";
  nodes: Map<string, TreeNode>;
  rootPoles: string[]; // poles directly connected to the DT
}

/* -------------------------------------------------------------------------- */
/*  In-memory topology cache                                                   */
/* -------------------------------------------------------------------------- */

/** DT ID → built tree */
const treeCache = new Map<string, DTTree>();

/** Feeder ID → list of DT IDs */
const feederToDTs = new Map<string, string[]>();

// For 40% of transformers with digitized line data:
// We connect poles in sequence using parent_pole_id and seq_on_line.
function buildSurveyedTree(
  dt: Transformer,
  dtPoles: Pole[]
): DTTree {
  const nodes = new Map<string, TreeNode>();

  for (const p of dtPoles) {
    nodes.set(p.poleId, {
      poleId: p.poleId,
      lat: p.lat,
      lon: p.lon,
      dtId: p.dtId,
      feederId: p.feederId,
      ward: p.ward,
      pincode: p.pincode,
      deviceId: p.deviceId,
      topologySource: "surveyed",
      parent: p.parentPoleId || dt.dtId,
      children: [],
      depth: p.seqOnLine || 0,
    });
  }

  const rootPoles: string[] = [];
  for (const [poleId, node] of nodes) {
    if (node.parent === dt.dtId || !nodes.has(node.parent!)) {
      node.parent = dt.dtId;
      rootPoles.push(poleId);
    } else {
      const parentNode = nodes.get(node.parent!);
      if (parentNode) {
        parentNode.children.push(poleId);
      }
    }
  }

  for (const rootId of rootPoles) {
    const queue: Array<{ id: string; depth: number }> = [
      { id: rootId, depth: 1 },
    ];
    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      const node = nodes.get(id)!;
      node.depth = depth;
      for (const childId of node.children) {
        queue.push({ id: childId, depth: depth + 1 });
      }
    }
  }

  return {
    dtId: dt.dtId,
    feederId: dt.feederId,
    dtLat: dt.lat,
    dtLon: dt.lon,
    householdsServed: dt.householdsServed,
    topologySource: "surveyed",
    nodes,
    rootPoles,
  };
}

// For 60% of transformers missing topology:
// Used Prim's Minimum Spanning Tree (MST) based on Haversine GPS distances to guess which pole feeds which.
// Took help from AI to structure the greedy Prim's algorithm graph logic efficiently.
const MAX_SPAN_DISTANCE_M = 120; // Max realistic distance between consecutive poles on a street

function buildInferredTree(
  dt: Transformer,
  dtPoles: Pole[]
): DTTree {
  if (dtPoles.length === 0) {
    return {
      dtId: dt.dtId,
      feederId: dt.feederId,
      dtLat: dt.lat,
      dtLon: dt.lon,
      householdsServed: dt.householdsServed,
      topologySource: "inferred",
      nodes: new Map(),
      rootPoles: [],
    };
  }

  const nodes = new Map<string, TreeNode>();

  // Create nodes (no parent/children yet)
  for (const p of dtPoles) {
    nodes.set(p.poleId, {
      poleId: p.poleId,
      lat: p.lat,
      lon: p.lon,
      dtId: p.dtId,
      feederId: p.feederId,
      ward: p.ward,
      pincode: p.pincode,
      deviceId: p.deviceId,
      topologySource: "inferred",
      parent: null,
      children: [],
      depth: 0,
    });
  }

  // Prim's algorithm starting from the DT location
  // "Virtual root" is the DT itself — find the closest pole to the DT as the
  // first root pole, then grow outward

  const inTree = new Set<string>();
  const poleIds = dtPoles.map((p) => p.poleId);

  // Distance from DT to each pole
  const dtDistances = new Map<string, number>();
  for (const p of dtPoles) {
    dtDistances.set(p.poleId, haversineDistance(dt.lat, dt.lon, p.lat, p.lon));
  }

  // Start with the closest pole to the DT
  let closest = poleIds[0];
  let closestDist = dtDistances.get(closest)!;
  for (const id of poleIds) {
    const d = dtDistances.get(id)!;
    if (d < closestDist) {
      closest = id;
      closestDist = d;
    }
  }

  inTree.add(closest);
  const rootNode = nodes.get(closest)!;
  rootNode.parent = dt.dtId;
  rootNode.depth = 1;
  const rootPoles = [closest];

  // Greedy growth: repeatedly add the nearest pole to any pole already in the tree
  while (inTree.size < poleIds.length) {
    let bestPole: string | null = null;
    let bestParent: string | null = null;
    let bestDist = Infinity;

    for (const candidateId of poleIds) {
      if (inTree.has(candidateId)) continue;
      const candidateNode = nodes.get(candidateId)!;

      for (const treeId of inTree) {
        const treeNode = nodes.get(treeId)!;
        const dist = haversineDistance(
          treeNode.lat,
          treeNode.lon,
          candidateNode.lat,
          candidateNode.lon
        );

        if (dist < bestDist) {
          bestDist = dist;
          bestPole = candidateId;
          bestParent = treeId;
        }
      }
    }

    if (!bestPole || !bestParent) break;

    // If the best distance exceeds our cap, this pole might belong to a
    // disconnected cluster. Still add it but it will be a new "root" off the DT
    if (bestDist > MAX_SPAN_DISTANCE_M) {
      const node = nodes.get(bestPole)!;
      node.parent = dt.dtId;
      node.depth = 1;
      rootPoles.push(bestPole);
    } else {
      const parentNode = nodes.get(bestParent)!;
      const childNode = nodes.get(bestPole)!;
      childNode.parent = bestParent;
      childNode.depth = parentNode.depth + 1;
      parentNode.children.push(bestPole);
    }

    inTree.add(bestPole);
  }

  return {
    dtId: dt.dtId,
    feederId: dt.feederId,
    dtLat: dt.lat,
    dtLon: dt.lon,
    householdsServed: dt.householdsServed,
    topologySource: "inferred",
    nodes,
    rootPoles,
  };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Load and build the tree for a specific DT. Caches the result.
 */
export async function getDTTree(dtId: string): Promise<DTTree | null> {
  if (treeCache.has(dtId)) {
    return treeCache.get(dtId)!;
  }

  const [dt] = await db
    .select()
    .from(transformers)
    .where(eq(transformers.dtId, dtId));

  if (!dt) return null;

  const dtPoles = await db
    .select()
    .from(poles)
    .where(eq(poles.dtId, dtId));

  // Decide whether to use surveyed or inferred topology
  const hasSurveyedTopology = dtPoles.some(
    (p) => p.seqOnLine !== null && p.parentPoleId !== null
  );

  const tree = hasSurveyedTopology
    ? buildSurveyedTree(dt, dtPoles)
    : buildInferredTree(dt, dtPoles);

  treeCache.set(dtId, tree);
  return tree;
}

/**
 * Load all DT trees and build the feeder index.
 */
export async function loadAllTopology(): Promise<void> {
  console.log("Loading network topology...");

  const allDTs = await db.select().from(transformers);
  const allPoles = await db.select().from(poles);

  // Group poles by DT
  const polesByDT = new Map<string, Pole[]>();
  for (const p of allPoles) {
    if (!polesByDT.has(p.dtId)) {
      polesByDT.set(p.dtId, []);
    }
    polesByDT.get(p.dtId)!.push(p);
  }

  // Build trees
  let surveyedCount = 0;
  let inferredCount = 0;

  for (const dt of allDTs) {
    const dtPoles = polesByDT.get(dt.dtId) || [];
    const hasSurveyedTopology = dtPoles.some(
      (p) => p.seqOnLine !== null && p.parentPoleId !== null
    );

    const tree = hasSurveyedTopology
      ? buildSurveyedTree(dt, dtPoles)
      : buildInferredTree(dt, dtPoles);

    treeCache.set(dt.dtId, tree);

    if (hasSurveyedTopology) surveyedCount++;
    else inferredCount++;

    // Build feeder index
    if (!feederToDTs.has(dt.feederId)) {
      feederToDTs.set(dt.feederId, []);
    }
    feederToDTs.get(dt.feederId)!.push(dt.dtId);
  }

  console.log(
    `Topology loaded: ${surveyedCount} surveyed, ${inferredCount} inferred, ${allPoles.length} total poles`
  );
}

/**
 * Get all DT IDs for a given feeder.
 */
export function getDTsForFeeder(feederId: string): string[] {
  return feederToDTs.get(feederId) || [];
}

/**
 * Get a cached tree (null if not loaded).
 */
export function getCachedTree(dtId: string): DTTree | undefined {
  return treeCache.get(dtId);
}

/**
 * Get all cached trees.
 */
export function getAllTrees(): Map<string, DTTree> {
  return treeCache;
}

/**
 * Invalidate cache for a DT (e.g., after topology update).
 */
export function invalidateTree(dtId: string): void {
  treeCache.delete(dtId);
}

/**
 * Count of all downstream poles from a given pole (inclusive).
 */
export function countDownstream(tree: DTTree, poleId: string): number {
  const node = tree.nodes.get(poleId);
  if (!node) return 0;

  let count = 1;
  for (const childId of node.children) {
    count += countDownstream(tree, childId);
  }
  return count;
}

/**
 * Get all pole IDs downstream of a given pole (inclusive).
 */
export function getDownstreamPoles(tree: DTTree, poleId: string): string[] {
  const result: string[] = [];
  const node = tree.nodes.get(poleId);
  if (!node) return result;

  result.push(poleId);
  for (const childId of node.children) {
    result.push(...getDownstreamPoles(tree, childId));
  }
  return result;
}
