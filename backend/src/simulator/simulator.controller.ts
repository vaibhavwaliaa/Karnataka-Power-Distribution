import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { poles, poleState, transformers, telemetry } from "../db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  getCachedTree,
  getAllTrees,
  getDownstreamPoles,
} from "../detection/topology.service";
import { forceDetection } from "../detection/debounce.service";
import { io } from "../index";

export const simulatorRouter = Router();

/* -------------------------------------------------------------------------- */
/*  POST /api/simulator/inject-fault                                           */
/*  Simulate a fault by setting affected poles to dark + sending telemetry.     */
/* -------------------------------------------------------------------------- */

simulatorRouter.post("/inject-fault", async (req: Request, res: Response) => {
  try {
    const { faultType, dtId, poleId, feederId } = req.body;

    if (!faultType) {
      res.status(400).json({ error: "Missing faultType (span, dt, feeder)" });
      return;
    }

    let affectedPoles: string[] = [];
    let targetDtId = dtId;

    switch (faultType) {
      case "span": {
        if (!dtId || !poleId) {
          res.status(400).json({
            error: "Span fault requires dtId and poleId (first dark pole)",
          });
          return;
        }
        const tree = getCachedTree(dtId);
        if (!tree) {
          res.status(404).json({ error: `DT ${dtId} not found` });
          return;
        }
        affectedPoles = getDownstreamPoles(tree, poleId);
        break;
      }

      case "dt": {
        if (!dtId) {
          res.status(400).json({ error: "DT fault requires dtId" });
          return;
        }
        const tree = getCachedTree(dtId);
        if (!tree) {
          res.status(404).json({ error: `DT ${dtId} not found` });
          return;
        }
        affectedPoles = Array.from(tree.nodes.keys());
        break;
      }

      case "feeder": {
        // Not implemented in this simulator for simplicity
        res.status(400).json({
          error:
            "Feeder fault simulation: set all DTs on the feeder to dark. Use dt fault on each.",
        });
        return;
      }

      default:
        res.status(400).json({ error: "Invalid faultType. Use: span, dt, feeder" });
        return;
    }

    if (affectedPoles.length === 0) {
      res.status(400).json({ error: "No poles affected" });
      return;
    }

    // Simulate: set affected poles to dark
    const now = new Date();
    for (const pid of affectedPoles) {
      // Update pole state
      await db
        .update(poleState)
        .set({
          currentStatus: "dark",
          lastEventType: "power_lost",
          lastEventTs: now,
          updatedAt: now,
        })
        .where(eq(poleState.poleId, pid));
    }

    // Simulate the ~30% of dying messages that never arrive
    // (Skip sending telemetry for ~30% of poles)
    const polesWithDevices = [];
    for (const pid of affectedPoles) {
      const [pole] = await db
        .select()
        .from(poles)
        .where(eq(poles.poleId, pid));
      if (pole?.deviceId) {
        polesWithDevices.push(pole);
      }
    }

    let sentCount = 0;
    let skippedCount = 0;
    for (const pole of polesWithDevices) {
      // 70% chance of successfully sending power_lost
      // 8% chance of being firmware 1.2 (which doesn't send power_lost)
      const isFw12 = Math.random() < 0.08;
      const sendSuccess = Math.random() < 0.70;

      if (!isFw12 && sendSuccess) {
        // Insert telemetry record
        await db.insert(telemetry).values({
          deviceId: pole.deviceId!,
          poleId: pole.poleId,
          event: "power_lost",
          energized: false,
          ts: new Date(now.getTime() + Math.random() * 5000), // 0-5s jitter
          seq: Math.floor(Math.random() * 100000),
          raw: {
            device_id: pole.deviceId,
            pole_id: pole.poleId,
            event: "power_lost",
            energized: false,
            battery_mv: 3200 + Math.floor(Math.random() * 400),
            rssi: -80 - Math.floor(Math.random() * 30),
            fw: "1.4.2",
          },
        }).onConflictDoNothing();
        sentCount++;
      } else {
        skippedCount++;
      }
    }

    // Broadcast state changes
    io.emit("poles:updated", {
      poleIds: affectedPoles,
      status: "dark",
    });

    // Force fault detection (bypass debounce for simulation speed)
    await forceDetection(targetDtId);

    res.json({
      message: `Injected ${faultType} fault`,
      affectedPoles: affectedPoles.length,
      telemetrySent: sentCount,
      telemetrySkipped: skippedCount,
      note: `${skippedCount} dying messages were "lost" (simulating 30% message loss + firmware 1.2 devices)`,
    });
  } catch (err) {
    console.error("[Simulator] Inject fault error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*  POST /api/simulator/repair                                                 */
/*  Restore power to all poles in a DT (or a specific set)                     */
/* -------------------------------------------------------------------------- */

simulatorRouter.post("/repair", async (req: Request, res: Response) => {
  try {
    const { dtId, poleIds } = req.body;

    if (!dtId) {
      res.status(400).json({ error: "Missing dtId" });
      return;
    }

    // Get poles to repair
    let polesToRepair: string[];
    if (poleIds && Array.isArray(poleIds)) {
      polesToRepair = poleIds;
    } else {
      // Repair all dark poles under this DT
      const tree = getCachedTree(dtId);
      if (!tree) {
        res.status(404).json({ error: `DT ${dtId} not found` });
        return;
      }
      polesToRepair = Array.from(tree.nodes.keys());
    }

    const now = new Date();

    // Set all affected poles back to live
    for (const pid of polesToRepair) {
      await db
        .update(poleState)
        .set({
          currentStatus: "live",
          lastEventType: "power_restored",
          lastEventTs: now,
          lastHeartbeatTs: now,
          updatedAt: now,
        })
        .where(eq(poleState.poleId, pid));
    }

    // Generate restoration telemetry (boot + power_restored)
    const polesData = await db
      .select()
      .from(poles)
      .where(inArray(poles.poleId, polesToRepair));

    let telemetrySent = 0;
    for (const pole of polesData) {
      if (!pole.deviceId) continue;

      // Devices send boot then power_restored within ~20s
      const bootTime = new Date(now.getTime() + Math.random() * 10000);
      const restoreTime = new Date(bootTime.getTime() + Math.random() * 20000);

      await db.insert(telemetry).values([
        {
          deviceId: pole.deviceId,
          poleId: pole.poleId,
          event: "boot",
          energized: true,
          ts: bootTime,
          seq: Math.floor(Math.random() * 100000),
          raw: { event: "boot", energized: true },
        },
        {
          deviceId: pole.deviceId,
          poleId: pole.poleId,
          event: "power_restored",
          energized: true,
          ts: restoreTime,
          seq: Math.floor(Math.random() * 100000) + 1,
          raw: { event: "power_restored", energized: true },
        },
      ]).onConflictDoNothing();
      telemetrySent += 2;
    }

    // Broadcast state changes
    io.emit("poles:updated", {
      poleIds: polesToRepair,
      status: "live",
    });

    // Trigger auto-verification check
    // Import here to avoid circular deps
    const { checkAutoVerification } = require("../tickets/ticket.controller");
    for (const pid of polesToRepair) {
      await checkAutoVerification(pid);
    }

    res.json({
      message: "Repair simulated",
      repairedPoles: polesToRepair.length,
      telemetrySent,
    });
  } catch (err) {
    console.error("[Simulator] Repair error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*  POST /api/simulator/kill-sensor                                            */
/*  Simulate a dead sensor (device offline, power is fine)                     */
/* -------------------------------------------------------------------------- */

simulatorRouter.post("/kill-sensor", async (req: Request, res: Response) => {
  try {
    const { poleId } = req.body;

    if (!poleId) {
      res.status(400).json({ error: "Missing poleId" });
      return;
    }

    // Mark this pole as "unknown" — it stops reporting but power is fine
    const now = new Date();
    await db
      .update(poleState)
      .set({
        currentStatus: "unknown",
        lastEventTs: now,
        updatedAt: now,
      })
      .where(eq(poleState.poleId, poleId));

    io.emit("poles:updated", {
      poleIds: [poleId],
      status: "unknown",
    });

    res.json({
      message: `Sensor killed at ${poleId} — pole is still energized but device is offline`,
      note: "This should NOT generate a fault ticket",
    });
  } catch (err) {
    console.error("[Simulator] Kill sensor error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*  GET /api/simulator/network-info                                            */
/*  Get network structure for the simulator UI                                 */
/* -------------------------------------------------------------------------- */

simulatorRouter.get("/network-info", async (_req: Request, res: Response) => {
  try {
    const allTrees = getAllTrees();
    const dtSummaries = [];

    for (const [dtId, tree] of allTrees) {
      const poleIds = Array.from(tree.nodes.keys());
      dtSummaries.push({
        dtId,
        feederId: tree.feederId,
        lat: tree.dtLat,
        lon: tree.dtLon,
        poleCount: poleIds.length,
        topologySource: tree.topologySource,
        rootPoles: tree.rootPoles,
        samplePoles: poleIds.slice(0, 10), // First 10 poles for the UI picker
      });
    }

    res.json({
      totalDTs: dtSummaries.length,
      totalPoles: dtSummaries.reduce((s, d) => s + d.poleCount, 0),
      dts: dtSummaries,
    });
  } catch (err) {
    console.error("[Simulator] Network info error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
