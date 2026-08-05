import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { tickets, ticketAffectedPoles, poleState } from "../db/schema";
import { eq, desc, inArray, and, not } from "drizzle-orm";
import { io } from "../index";
import { generateAIBrief, generateTemplateBrief } from "../detection/dispatch-brief";
import type { DetectedFault } from "../detection/fault-finder";

export const ticketRouter = Router();

/**
 * GET /api/tickets — List all tickets, newest first
 */
ticketRouter.get("/", async (_req: Request, res: Response) => {
  try {
    const allTickets = await db
      .select()
      .from(tickets)
      .orderBy(desc(tickets.createdAt))
      .limit(200);

    res.json(allTickets);
  } catch (err) {
    console.error("[Tickets] List error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/tickets/:id — Get single ticket with affected poles
 */
ticketRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const idParam = req.params.id as string;
    const ticketId = parseInt(idParam, 10);
    if (isNaN(ticketId)) {
      res.status(400).json({ error: "Invalid ticket ID" });
      return;
    }

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId));

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    // Get affected poles
    const affected = await db
      .select()
      .from(ticketAffectedPoles)
      .where(eq(ticketAffectedPoles.ticketId, ticketId));

    res.json({
      ...ticket,
      affectedPoles: affected.map((a) => a.poleId),
    });
  } catch (err) {
    console.error("[Tickets] Get error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// State machine enforcing valid ticket status transitions:
// detected -> acknowledged -> crew_assigned -> resolved -> verified -> closed
const VALID_TRANSITIONS: Record<string, string[]> = {
  detected: ["acknowledged"],
  acknowledged: ["crew_assigned"],
  crew_assigned: ["resolved"],
  resolved: ["verified", "crew_assigned"],
  verified: ["closed"],
};

// State transition handler.
// IMPORTANT: If someone tries to click "Mark Resolved", we check live telemetry first.
// If poles are still dark, we reject the state change (requirement from 00-candidate-brief.md).
ticketRouter.patch("/:id/status", async (req: Request, res: Response) => {
  try {
    const idParam = req.params.id as string;
    const ticketId = parseInt(idParam, 10);
    const { status: newStatus } = req.body;

    if (!newStatus) {
      res.status(400).json({ error: "Missing status" });
      return;
    }

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId));

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    // Validate state transition
    const allowed = VALID_TRANSITIONS[ticket.status] || [];
    if (!allowed.includes(newStatus)) {
      res.status(400).json({
        error: `Cannot transition from '${ticket.status}' to '${newStatus}'`,
        allowed,
      });
      return;
    }

    // ---- Special handling: "resolved" requires telemetry verification ----
    if (newStatus === "resolved") {
      const verificationResult = await verifyRestoration(ticketId);
      if (!verificationResult.allLive) {
        res.status(409).json({
          error: "Cannot mark as resolved — affected poles are still dark",
          darkPoles: verificationResult.darkPoles,
          totalAffected: verificationResult.total,
          liveCount: verificationResult.liveCount,
          message:
            "Restoration must be verified from telemetry. " +
            `${verificationResult.darkPoles.length} of ${verificationResult.total} affected poles are still dark.`,
        });
        return;
      }
    }

    // Perform the transition
    const timestampField = `${newStatus}At` as keyof typeof ticket;
    const updateData: any = {
      status: newStatus,
    };

    // Set the appropriate timestamp
    switch (newStatus) {
      case "acknowledged":
        updateData.acknowledgedAt = new Date();
        break;
      case "crew_assigned":
        updateData.crewAssignedAt = new Date();
        break;
      case "resolved":
        updateData.resolvedAt = new Date();
        break;
      case "verified":
        updateData.verifiedAt = new Date();
        break;
      case "closed":
        updateData.closedAt = new Date();
        break;
    }

    const [updated] = await db
      .update(tickets)
      .set(updateData)
      .where(eq(tickets.id, ticketId))
      .returning();

    console.log(
      `[Tickets] Ticket #${ticketId}: ${ticket.status} → ${newStatus}`
    );

    // Broadcast update
    io.emit("ticket:updated", updated);

    res.json(updated);
  } catch (err) {
    console.error("[Tickets] Status update error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*  Telemetry-based restoration verification                                   */
/* -------------------------------------------------------------------------- */

interface VerificationResult {
  allLive: boolean;
  total: number;
  liveCount: number;
  darkPoles: string[];
}

async function verifyRestoration(
  ticketId: number
): Promise<VerificationResult> {
  // Get all affected poles for this ticket
  const affected = await db
    .select()
    .from(ticketAffectedPoles)
    .where(eq(ticketAffectedPoles.ticketId, ticketId));

  if (affected.length === 0) {
    return { allLive: true, total: 0, liveCount: 0, darkPoles: [] };
  }

  const poleIds = affected.map((a) => a.poleId);

  // Check current state of each pole
  const states = await db
    .select()
    .from(poleState)
    .where(inArray(poleState.poleId, poleIds));

  const darkPoles: string[] = [];
  let liveCount = 0;

  for (const state of states) {
    if (state.currentStatus === "live") {
      liveCount++;
    } else {
      darkPoles.push(state.poleId);
    }
  }

  // Consider poles without state records (no device) as "ok" for verification
  // — we can only verify poles that have devices
  const polesWithState = new Set(states.map((s) => s.poleId));
  const polesWithoutDevices = poleIds.filter((id) => !polesWithState.has(id));

  return {
    allLive: darkPoles.length === 0,
    total: poleIds.length,
    liveCount: liveCount + polesWithoutDevices.length,
    darkPoles,
  };
}

/**
 * Auto-verification: called when poles come back to life.
 * Checks if any open ticket's affected poles are all live now.
 */
export async function checkAutoVerification(poleId: string): Promise<void> {
  // Find tickets that include this pole
  const affectedEntries = await db
    .select()
    .from(ticketAffectedPoles)
    .where(eq(ticketAffectedPoles.poleId, poleId));

  for (const entry of affectedEntries) {
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.id, entry.ticketId),
          // Only auto-verify tickets that are in the right state
          not(eq(tickets.status, "verified")),
          not(eq(tickets.status, "closed"))
        )
      );

    if (!ticket) continue;

    const verification = await verifyRestoration(entry.ticketId);
    if (verification.allLive) {
      // All poles are live — auto-verify!
      await db
        .update(tickets)
        .set({
          status: "verified",
          verifiedAt: new Date(),
        })
        .where(eq(tickets.id, entry.ticketId));

      console.log(
        `[Tickets] Ticket #${entry.ticketId} auto-verified — all affected poles are live`
      );

      const [updatedTicket] = await db
        .select()
        .from(tickets)
        .where(eq(tickets.id, entry.ticketId));

      io.emit("ticket:updated", updatedTicket);
    }
  }
}

/**
 * POST /api/tickets/:id/dispatch-brief — Generate AI dispatch brief
 */
ticketRouter.post("/:id/dispatch-brief", async (req: Request, res: Response) => {
  try {
    const idParam = req.params.id as string;
    const ticketId = parseInt(idParam, 10);

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId));

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    // Get affected poles
    const affected = await db
      .select()
      .from(ticketAffectedPoles)
      .where(eq(ticketAffectedPoles.ticketId, ticketId));

    // Build DetectedFault from ticket data
    const fault: DetectedFault = {
      faultType: ticket.faultType as "span" | "dt" | "feeder",
      spanStartPole: ticket.spanStartPole,
      spanEndPole: ticket.spanEndPole,
      dtId: ticket.dtId,
      feederId: ticket.feederId,
      lat: parseFloat(ticket.lat as any),
      lon: parseFloat(ticket.lon as any),
      pincode: ticket.pincode,
      affectedPoleIds: affected.map((a) => a.poleId),
      affectedPoleCount: ticket.affectedPoleCount ?? 0,
      affectedHouseholds: ticket.affectedHouseholds ?? 0,
      confidence: parseFloat(ticket.confidence as any),
      confidenceReason: ticket.confidenceReason ?? "",
    };

    // Generate brief (AI if available, template fallback)
    const useAI = req.query.ai !== "false";
    const brief = useAI
      ? await generateAIBrief(fault)
      : generateTemplateBrief(fault);

    // Save to DB
    await db
      .update(tickets)
      .set({ dispatchBrief: brief })
      .where(eq(tickets.id, ticketId));

    res.json({ brief, source: useAI && process.env.GEMINI_API_KEY ? "gemini" : "template" });
  } catch (err) {
    console.error("[Tickets] Dispatch brief error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
