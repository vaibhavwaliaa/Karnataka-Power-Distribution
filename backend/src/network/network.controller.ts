import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { poles, transformers, poleState } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { getAllTrees, getCachedTree } from "../detection/topology.service";

export const networkRouter = Router();

/**
 * GET /api/network/poles — All poles with current state
 */
networkRouter.get("/poles", async (_req: Request, res: Response) => {
  try {
    const allPoles = await db
      .select({
        poleId: poles.poleId,
        lat: poles.lat,
        lon: poles.lon,
        feederId: poles.feederId,
        dtId: poles.dtId,
        ward: poles.ward,
        pincode: poles.pincode,
        deviceId: poles.deviceId,
        topologySource: poles.topologySource,
        currentStatus: poleState.currentStatus,
      })
      .from(poles)
      .leftJoin(poleState, eq(poles.poleId, poleState.poleId));

    res.json(allPoles);
  } catch (err) {
    console.error("[Network] Poles error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/network/transformers — All DTs
 */
networkRouter.get("/transformers", async (_req: Request, res: Response) => {
  try {
    const allDTs = await db.select().from(transformers);
    res.json(allDTs);
  } catch (err) {
    console.error("[Network] Transformers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/network/stats — Quick stats for the dashboard
 */
networkRouter.get("/stats", async (_req: Request, res: Response) => {
  try {
    const [poleStats] = await db
      .select({
        total: sql<number>`count(*)`,
        live: sql<number>`count(*) filter (where ${poleState.currentStatus} = 'live')`,
        dark: sql<number>`count(*) filter (where ${poleState.currentStatus} = 'dark')`,
        unknown: sql<number>`count(*) filter (where ${poleState.currentStatus} = 'unknown')`,
      })
      .from(poleState);

    const [dtStats] = await db
      .select({ total: sql<number>`count(*)` })
      .from(transformers);

    res.json({
      poles: poleStats,
      transformers: dtStats.total,
    });
  } catch (err) {
    console.error("[Network] Stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/network/topology/:dtId — Tree structure for a specific DT
 */
networkRouter.get("/topology/:dtId", async (req: Request, res: Response) => {
  try {
    const dtId = req.params.dtId as string;
    const tree = getCachedTree(dtId);
    if (!tree) {
      res.status(404).json({ error: "DT not found" });
      return;
    }

    // Serialize the tree for the frontend
    const nodes = [];
    for (const [poleId, node] of tree.nodes) {
      nodes.push({
        poleId: node.poleId,
        lat: node.lat,
        lon: node.lon,
        parent: node.parent,
        children: node.children,
        depth: node.depth,
        deviceId: node.deviceId,
        topologySource: node.topologySource,
      });
    }

    res.json({
      dtId: tree.dtId,
      feederId: tree.feederId,
      dtLat: tree.dtLat,
      dtLon: tree.dtLon,
      topologySource: tree.topologySource,
      rootPoles: tree.rootPoles,
      nodes,
    });
  } catch (err) {
    console.error("[Network] Topology error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
