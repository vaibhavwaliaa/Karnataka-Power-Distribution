import { Router, Request, Response } from "express";
import { z } from "zod";
import { processTelemetry } from "./state.service";

export const telemetryRouter = Router();

// Telemetry HTTP ingestion endpoint.
// Validates incoming JSON telemetry payloads against the spec schema using Zod.

const telemetryPayloadSchema = z.object({
  device_id: z.string(),
  pole_id: z.string(),
  event: z.enum(["heartbeat", "power_lost", "power_restored", "boot"]),
  energized: z.boolean(),
  ts: z.string().datetime(),
  seq: z.number().int(),
  battery_mv: z.number().optional(),
  rssi: z.number().optional(),
  fw: z.string().optional(),
});

const batchSchema = z.array(telemetryPayloadSchema);

// Endpoint accepting single or batch telemetry events from pole sensors
telemetryRouter.post("/", async (req: Request, res: Response) => {
  try {
    // Accept single or batch
    const body = Array.isArray(req.body) ? req.body : [req.body];
    const parsed = batchSchema.safeParse(body);

    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid telemetry payload",
        details: parsed.error.issues,
      });
      return;
    }

    const results = await processTelemetry(parsed.data);

    res.status(202).json({
      accepted: results.accepted,
      duplicates: results.duplicates,
      stale: results.stale,
    });
  } catch (err) {
    console.error("[Telemetry] Ingest error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
