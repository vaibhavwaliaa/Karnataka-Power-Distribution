import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { scheduledOutages } from "../db/schema";
import { gte, lte, and } from "drizzle-orm";

export const scheduledOutageRouter = Router();

/**
 * GET /api/scheduled-outages — List scheduled outages
 */
scheduledOutageRouter.get("/", async (req: Request, res: Response) => {
  try {
    const from = req.query.from
      ? new Date(req.query.from as string)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = req.query.to
      ? new Date(req.query.to as string)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const outages = await db
      .select()
      .from(scheduledOutages)
      .where(
        and(
          gte(scheduledOutages.end, from),
          lte(scheduledOutages.start, to)
        )
      );

    res.json(outages);
  } catch (err) {
    console.error("[Outages] List error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/scheduled-outages — Create a scheduled outage (for simulator)
 */
scheduledOutageRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { id, scope, targetId, start, end, reason } = req.body;

    if (!scope || !targetId || !start || !end) {
      res.status(400).json({
        error: "Missing required fields: scope, targetId, start, end",
      });
      return;
    }

    const [outage] = await db
      .insert(scheduledOutages)
      .values({
        id: id || `SO-${Date.now()}`,
        scope,
        targetId,
        start: new Date(start),
        end: new Date(end),
        reason: reason || "Scheduled outage",
      })
      .returning();

    res.status(201).json(outage);
  } catch (err) {
    console.error("[Outages] Create error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
