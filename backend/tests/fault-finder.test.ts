/**
 * Unit Tests — Fault Localization Algorithm
 *
 * These tests exercise the pure algorithm in fault-finder.ts
 * using hand-crafted in-memory tree structures.
 *
 * Test scenarios map directly to the assignment brief:
 * - Span faults (single, mid-tree, multi-branch)
 * - DT-level faults (whole transformer dark)
 * - Dead sensor detection (dark pole with live children)
 * - Confidence scoring (surveyed vs inferred)
 * - Unknown pole handling (9% no device)
 * - Edge cases (empty tree, single pole, root fault)
 */

import { describe, it, expect } from "vitest";
import {
  findSpanFaults,
  checkDTFault,
  computeConfidence,
  getMostCommon,
  type PoleStatus,
} from "../src/detection/fault-finder";
import type { DTTree, TreeNode } from "../src/detection/topology.service";

/* -------------------------------------------------------------------------- */
/*  Test helpers — build trees without a DB                                    */
/* -------------------------------------------------------------------------- */

function makeNode(
  id: string,
  opts: Partial<TreeNode> = {}
): TreeNode {
  return {
    poleId: id,
    lat: opts.lat ?? 12.97,
    lon: opts.lon ?? 77.59,
    dtId: opts.dtId ?? "DT-001",
    feederId: opts.feederId ?? "F-01",
    ward: opts.ward ?? null,
    pincode: opts.pincode ?? "560001",
    deviceId: opts.deviceId ?? `DEV-${id}`,
    topologySource: opts.topologySource ?? "surveyed",
    parent: opts.parent ?? null,
    children: opts.children ?? [],
    depth: opts.depth ?? 0,
  };
}

function makeTree(
  nodes: TreeNode[],
  overrides: Partial<DTTree> = {}
): DTTree {
  const nodeMap = new Map<string, TreeNode>();
  for (const n of nodes) nodeMap.set(n.poleId, n);

  const rootPoles = nodes
    .filter((n) => n.parent === null || n.parent === (overrides.dtId ?? "DT-001"))
    .map((n) => n.poleId);

  return {
    dtId: overrides.dtId ?? "DT-001",
    feederId: overrides.feederId ?? "F-01",
    dtLat: overrides.dtLat ?? 12.97,
    dtLon: overrides.dtLon ?? 77.59,
    householdsServed: overrides.householdsServed ?? 200,
    topologySource: overrides.topologySource ?? "surveyed",
    nodes: nodeMap,
    rootPoles: overrides.rootPoles ?? rootPoles,
  };
}

function makeStateMap(
  states: Record<string, PoleStatus>
): Map<string, PoleStatus> {
  return new Map(Object.entries(states));
}

/* -------------------------------------------------------------------------- */
/*  Build a standard test tree:                                                */
/*                                                                             */
/*          DT-001                                                             */
/*            |                                                                */
/*           P1 (root)                                                         */
/*          / \                                                                */
/*        P2   P3                                                              */
/*        |   / \                                                              */
/*       P4  P5  P6                                                            */
/*       |                                                                     */
/*      P7                                                                     */
/* -------------------------------------------------------------------------- */

function makeStandardTree(overrides: Partial<DTTree> = {}): DTTree {
  return makeTree(
    [
      makeNode("P1", { parent: "DT-001", children: ["P2", "P3"], depth: 0 }),
      makeNode("P2", { parent: "P1", children: ["P4"], depth: 1 }),
      makeNode("P3", { parent: "P1", children: ["P5", "P6"], depth: 1 }),
      makeNode("P4", { parent: "P2", children: ["P7"], depth: 2 }),
      makeNode("P5", { parent: "P3", children: [], depth: 2 }),
      makeNode("P6", { parent: "P3", children: [], depth: 2 }),
      makeNode("P7", { parent: "P4", children: [], depth: 3 }),
    ],
    { rootPoles: ["P1"], ...overrides }
  );
}

/* ======================================================================== */
/*  TESTS                                                                    */
/* ======================================================================== */

describe("findSpanFaults", () => {
  it("should detect a single span fault at a leaf", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "live",
      P3: "live",
      P4: "live",
      P5: "live",
      P6: "dark", // ← fault here: P3 is live, P6 is dark
      P7: "live",
    });

    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(1);
    expect(faults[0].faultType).toBe("span");
    expect(faults[0].spanStartPole).toBe("P3");
    expect(faults[0].spanEndPole).toBe("P6");
    expect(faults[0].affectedPoleCount).toBe(1); // Only P6
  });

  it("should detect a mid-tree span fault affecting downstream", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "dark", // ← fault here: P1 live → P2 dark
      P3: "live",
      P4: "dark", // downstream of P2
      P5: "live",
      P6: "live",
      P7: "dark", // downstream of P2
    });

    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(1);
    expect(faults[0].spanStartPole).toBe("P1");
    expect(faults[0].spanEndPole).toBe("P2");
    expect(faults[0].affectedPoleCount).toBe(3); // P2, P4, P7
    expect(faults[0].affectedPoleIds).toContain("P2");
    expect(faults[0].affectedPoleIds).toContain("P4");
    expect(faults[0].affectedPoleIds).toContain("P7");
  });

  it("should detect a root fault (DT → first pole)", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "dark", // ← root fault
      P2: "dark",
      P3: "dark",
      P4: "dark",
      P5: "dark",
      P6: "dark",
      P7: "dark",
    });

    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(1);
    expect(faults[0].spanStartPole).toBe(null); // root → parent is DT
    expect(faults[0].spanEndPole).toBe("P1");
    expect(faults[0].affectedPoleCount).toBe(7); // All poles
  });

  it("should detect two independent span faults on different branches", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "live",
      P3: "live",
      P4: "dark", // ← fault 1: P2 live → P4 dark
      P5: "dark", // ← fault 2: P3 live → P5 dark
      P6: "live",
      P7: "dark", // downstream of P4
    });

    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(2);

    const fault1 = faults.find((f) => f.spanEndPole === "P4");
    const fault2 = faults.find((f) => f.spanEndPole === "P5");

    expect(fault1).toBeDefined();
    expect(fault1!.spanStartPole).toBe("P2");
    expect(fault1!.affectedPoleCount).toBe(2); // P4, P7

    expect(fault2).toBeDefined();
    expect(fault2!.spanStartPole).toBe("P3");
    expect(fault2!.affectedPoleCount).toBe(1); // P5 only
  });

  it("should detect NO faults when all poles are live", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "live",
      P3: "live",
      P4: "live",
      P5: "live",
      P6: "live",
      P7: "live",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(0);
  });

  it("should handle empty tree with no nodes", () => {
    const tree = makeTree([], { rootPoles: [] });
    const states = makeStateMap({});
    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(0);
  });

  it("should handle single-pole tree", () => {
    const tree = makeTree(
      [makeNode("P1", { parent: "DT-001", children: [] })],
      { rootPoles: ["P1"] }
    );

    // Single pole dark → fault
    const faults = findSpanFaults(
      tree,
      makeStateMap({ P1: "dark" })
    );
    expect(faults).toHaveLength(1);
    expect(faults[0].spanEndPole).toBe("P1");
    expect(faults[0].affectedPoleCount).toBe(1);

    // Single pole live → no fault
    const noFaults = findSpanFaults(
      tree,
      makeStateMap({ P1: "live" })
    );
    expect(noFaults).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Dead Sensor Detection                                                      */
/* -------------------------------------------------------------------------- */

describe("Dead sensor detection", () => {
  it("should NOT create a fault when a dark pole has live children", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "live",
      P3: "dark", // ← dead sensor: P3 dark but children are live
      P4: "live",
      P5: "live", // live child → impossible if P3 was truly de-energized
      P6: "live", // live child
      P7: "live",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(0);
    // No faults because the algorithm recognizes P3 as a dead sensor
  });

  it("should create a fault PAST a dead sensor", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "dark", // dead sensor: dark but P4 is live
      P3: "live",
      P4: "live", // child of P2 is live → P2 is dead sensor
      P5: "live",
      P6: "live",
      P7: "dark", // ← real fault: P4 live → P7 dark
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    expect(faults[0].spanStartPole).toBe("P4");
    expect(faults[0].spanEndPole).toBe("P7");
    // The dead sensor (P2) is skipped, fault detected past it
  });

  it("should NOT treat a dark pole with all dark children as dead sensor", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "live",
      P2: "live",
      P3: "dark", // ← this pole is dark
      P4: "live",
      P5: "dark", // all children dark → this IS a real fault
      P6: "dark",
      P7: "live",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    expect(faults[0].spanEndPole).toBe("P3");
    // P3 has all-dark children → it's a real fault boundary, not dead sensor
  });
});

/* -------------------------------------------------------------------------- */
/*  Unknown pole handling (poles without devices, 9% of network)               */
/* -------------------------------------------------------------------------- */

describe("Unknown pole handling", () => {
  it("should treat unknown poles as passthrough (continue walking)", () => {
    const tree = makeStandardTree();
    // P2 has no device — its status will be "unknown"
    tree.nodes.get("P2")!.deviceId = null;

    const states = makeStateMap({
      P1: "live",
      P2: "unknown", // no device, can't tell
      P3: "live",
      P4: "dark", // ← fault boundary here
      P5: "live",
      P6: "live",
      P7: "dark",
    });

    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(1);
    // P2 is unknown, but parent was live, so we treat P2 as passthrough
    // P4 is the actual boundary
    expect(faults[0].spanStartPole).toBe("P2");
    expect(faults[0].spanEndPole).toBe("P4");
  });

  it("should create fault at unknown→dark boundary", () => {
    const tree = makeStandardTree();
    tree.nodes.get("P3")!.deviceId = null;

    const states = makeStateMap({
      P1: "live",
      P2: "live",
      P3: "unknown", // no device
      P4: "live",
      P5: "dark", // ← fault: unknown parent → dark child
      P6: "live",
      P7: "live",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    expect(faults[0].spanStartPole).toBe("P3");
    expect(faults[0].spanEndPole).toBe("P5");
  });
});

/* -------------------------------------------------------------------------- */
/*  DT-level fault detection                                                   */
/* -------------------------------------------------------------------------- */

describe("checkDTFault", () => {
  it("should detect a DT fault when all poles are dark", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "dark",
      P2: "dark",
      P3: "dark",
      P4: "dark",
      P5: "dark",
      P6: "dark",
      P7: "dark",
    });

    const fault = checkDTFault(tree, states);

    expect(fault).not.toBeNull();
    expect(fault!.faultType).toBe("dt");
    expect(fault!.affectedPoleCount).toBe(7);
    expect(fault!.dtId).toBe("DT-001");
  });

  it("should NOT detect DT fault if ANY pole is live", () => {
    const tree = makeStandardTree();
    const states = makeStateMap({
      P1: "dark",
      P2: "dark",
      P3: "dark",
      P4: "dark",
      P5: "live", // ← one live pole breaks DT fault hypothesis
      P6: "dark",
      P7: "dark",
    });

    const fault = checkDTFault(tree, states);
    expect(fault).toBeNull();
  });

  it("should NOT detect DT fault if fewer than 3 devices report dark", () => {
    // Build a small tree with only 2 instrumented poles
    const tree = makeTree(
      [
        makeNode("P1", {
          parent: "DT-001",
          children: ["P2"],
          deviceId: "DEV-1",
        }),
        makeNode("P2", {
          parent: "P1",
          children: [],
          deviceId: "DEV-2",
        }),
      ],
      { rootPoles: ["P1"] }
    );

    const states = makeStateMap({
      P1: "dark",
      P2: "dark",
    });

    const fault = checkDTFault(tree, states);
    expect(fault).toBeNull();
    // Only 2 devices dark → below the 3-device threshold
  });

  it("should handle mix of dark and unknown in DT fault", () => {
    // 5 poles: 4 with devices (dark), 1 without (unknown)
    const tree = makeTree(
      [
        makeNode("P1", { parent: "DT-001", children: ["P2", "P3"] }),
        makeNode("P2", { parent: "P1", children: ["P4"] }),
        makeNode("P3", { parent: "P1", children: ["P5"] }),
        makeNode("P4", { parent: "P2", children: [] }),
        makeNode("P5", { parent: "P3", children: [], deviceId: null }),
      ],
      { rootPoles: ["P1"] }
    );

    const states = makeStateMap({
      P1: "dark",
      P2: "dark",
      P3: "dark",
      P4: "dark",
      P5: "unknown", // no device
    });

    const fault = checkDTFault(tree, states);
    expect(fault).not.toBeNull();
    expect(fault!.faultType).toBe("dt");
    // 4 devices reporting dark ≥ 3 threshold
  });

  it("should return null for empty tree", () => {
    const tree = makeTree([], { rootPoles: [] });
    const fault = checkDTFault(tree, makeStateMap({}));
    expect(fault).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Confidence scoring                                                         */
/* -------------------------------------------------------------------------- */

describe("computeConfidence", () => {
  it("should give higher confidence for surveyed topology", () => {
    const surveyedTree = makeStandardTree({ topologySource: "surveyed" });
    const inferredTree = makeStandardTree({ topologySource: "inferred" });

    const surveyedConf = computeConfidence(surveyedTree, 5, 5, false);
    const inferredConf = computeConfidence(inferredTree, 5, 5, false);

    expect(surveyedConf).toBeGreaterThan(inferredConf);
  });

  it("should give higher confidence with more device coverage", () => {
    const tree = makeStandardTree();

    const lowCoverage = computeConfidence(tree, 1, 5, false);
    const highCoverage = computeConfidence(tree, 5, 5, false);

    expect(highCoverage).toBeGreaterThan(lowCoverage);
  });

  it("should give DT fault bonus for ≥5 dark devices", () => {
    const tree = makeStandardTree();

    const noBonus = computeConfidence(tree, 4, 7, true);
    const withBonus = computeConfidence(tree, 5, 7, true);

    expect(withBonus).toBeGreaterThan(noBonus);
  });

  it("should clamp confidence between 0.1 and 0.99", () => {
    const tree = makeStandardTree();

    const conf = computeConfidence(tree, 100, 100, true);
    expect(conf).toBeLessThanOrEqual(0.99);
    expect(conf).toBeGreaterThanOrEqual(0.1);
  });

  it("should handle zero devices gracefully", () => {
    const tree = makeStandardTree();
    const conf = computeConfidence(tree, 0, 0, false);
    expect(conf).toBeGreaterThan(0);
    expect(Number.isFinite(conf)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Topology source (surveyed vs inferred) impact on results                   */
/* -------------------------------------------------------------------------- */

describe("Topology source impact", () => {
  it("should mention inferred topology in confidence reason", () => {
    const tree = makeStandardTree({ topologySource: "inferred" });
    const states = makeStateMap({
      P1: "live",
      P2: "dark",
      P3: "live",
      P4: "dark",
      P5: "live",
      P6: "live",
      P7: "dark",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    expect(faults[0].confidenceReason).toContain("inferred");
  });

  it("should mention surveyed topology in confidence reason", () => {
    const tree = makeStandardTree({ topologySource: "surveyed" });
    const states = makeStateMap({
      P1: "live",
      P2: "dark",
      P3: "live",
      P4: "dark",
      P5: "live",
      P6: "live",
      P7: "dark",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    expect(faults[0].confidenceReason).toContain("surveyed");
  });
});

/* -------------------------------------------------------------------------- */
/*  Fault location (lat/lon midpoint)                                          */
/* -------------------------------------------------------------------------- */

describe("Fault location computation", () => {
  it("should place fault at midpoint between live and dark poles", () => {
    const tree = makeTree(
      [
        makeNode("P1", {
          parent: "DT-001",
          children: ["P2"],
          lat: 12.0,
          lon: 77.0,
        }),
        makeNode("P2", {
          parent: "P1",
          children: [],
          lat: 13.0,
          lon: 78.0,
        }),
      ],
      {
        rootPoles: ["P1"],
        dtLat: 11.5,
        dtLon: 76.5,
      }
    );

    const states = makeStateMap({
      P1: "live",
      P2: "dark",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    // Midpoint of P1 (12, 77) and P2 (13, 78) = (12.5, 77.5)
    expect(faults[0].lat).toBeCloseTo(12.5, 5);
    expect(faults[0].lon).toBeCloseTo(77.5, 5);
  });

  it("should use DT location when root pole is the fault", () => {
    const tree = makeTree(
      [
        makeNode("P1", {
          parent: "DT-001",
          children: [],
          lat: 13.0,
          lon: 78.0,
        }),
      ],
      {
        rootPoles: ["P1"],
        dtLat: 12.0,
        dtLon: 77.0,
      }
    );

    const states = makeStateMap({ P1: "dark" });
    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(1);
    // Midpoint of DT (12, 77) and P1 (13, 78)
    expect(faults[0].lat).toBeCloseTo(12.5, 5);
    expect(faults[0].lon).toBeCloseTo(77.5, 5);
  });
});

/* -------------------------------------------------------------------------- */
/*  Affected households computation                                            */
/* -------------------------------------------------------------------------- */

describe("Affected households", () => {
  it("should estimate households proportionally", () => {
    const tree = makeStandardTree({ householdsServed: 700 });
    const states = makeStateMap({
      P1: "live",
      P2: "dark",
      P3: "live",
      P4: "dark",
      P5: "live",
      P6: "live",
      P7: "dark",
    });

    const faults = findSpanFaults(tree, states);
    expect(faults).toHaveLength(1);
    // 3 out of 7 poles affected → ~300 households
    expect(faults[0].affectedHouseholds).toBe(Math.round((3 / 7) * 700));
  });
});

/* -------------------------------------------------------------------------- */
/*  Helper: getMostCommon                                                      */
/* -------------------------------------------------------------------------- */

describe("getMostCommon", () => {
  it("should return null for empty array", () => {
    expect(getMostCommon([])).toBeNull();
  });

  it("should return the most frequent element", () => {
    expect(getMostCommon(["a", "b", "a", "c", "a"])).toBe("a");
  });

  it("should handle single element", () => {
    expect(getMostCommon(["x"])).toBe("x");
  });

  it("should handle tied elements (returns any one)", () => {
    const result = getMostCommon(["a", "b"]);
    expect(["a", "b"]).toContain(result);
  });
});

/* -------------------------------------------------------------------------- */
/*  Complex scenario: realistic 60% missing topology                          */
/* -------------------------------------------------------------------------- */

describe("Realistic scenario: inferred topology fault detection", () => {
  it("should correctly find faults on inferred topology with sparse devices", () => {
    // Simulate a tree where 40% of poles have no device (unknown status)
    const tree = makeTree(
      [
        makeNode("P1", {
          parent: "DT-001",
          children: ["P2", "P3"],
          deviceId: "D1",
        }),
        makeNode("P2", {
          parent: "P1",
          children: ["P4", "P5"],
          deviceId: null, // no device
        }),
        makeNode("P3", {
          parent: "P1",
          children: ["P6"],
          deviceId: "D3",
        }),
        makeNode("P4", {
          parent: "P2",
          children: [],
          deviceId: "D4",
        }),
        makeNode("P5", {
          parent: "P2",
          children: [],
          deviceId: null, // no device
        }),
        makeNode("P6", {
          parent: "P3",
          children: [],
          deviceId: "D6",
        }),
      ],
      {
        rootPoles: ["P1"],
        topologySource: "inferred",
      }
    );

    // Scenario: fault between P2 and its children
    // P2 has no device → unknown, but P4 (its child) is dark
    const states = makeStateMap({
      P1: "live",
      P2: "unknown", // no device
      P3: "live",
      P4: "dark", // fault here
      P5: "unknown", // no device, also affected
      P6: "live",
    });

    const faults = findSpanFaults(tree, states);

    expect(faults).toHaveLength(1);
    expect(faults[0].spanEndPole).toBe("P4");
    // Confidence should be lower due to inferred topology
    expect(faults[0].confidence).toBeLessThan(0.9);
    expect(faults[0].confidenceReason).toContain("inferred");
  });
});
