// Dispatch Brief Generator.
// Generates clear crew instructions for field repairs.
// Uses Gemini AI if GEMINI_API_KEY is configured, otherwise uses structured template fallback.

import type { DetectedFault } from "./fault-finder";

// Template-based dispatch brief (no API key needed)
export function generateTemplateBrief(fault: DetectedFault): string {
  const lines: string[] = [];

  // ---- Header ----
  switch (fault.faultType) {
    case "feeder":
      lines.push("⚠️ FEEDER-LEVEL FAULT — PRIORITY: CRITICAL");
      lines.push(`Feeder ${fault.feederId} is experiencing a complete outage.`);
      break;
    case "dt":
      lines.push("🔴 TRANSFORMER FAULT — PRIORITY: HIGH");
      lines.push(
        `Distribution Transformer ${fault.dtId} on Feeder ${fault.feederId} is fully de-energized.`
      );
      break;
    case "span":
      lines.push("🟡 SPAN FAULT — PRIORITY: STANDARD");
      lines.push(
        `Line fault detected on Feeder ${fault.feederId}, DT ${fault.dtId}.`
      );
      break;
  }

  lines.push("");

  // ---- Location ----
  lines.push("📍 LOCATION:");
  lines.push(`  Coordinates: ${fault.lat.toFixed(6)}°N, ${fault.lon.toFixed(6)}°E`);
  if (fault.pincode) {
    lines.push(`  PIN Code: ${fault.pincode}`);
  }

  if (fault.faultType === "span") {
    if (fault.spanStartPole && fault.spanEndPole) {
      lines.push(
        `  Fault boundary: between pole ${fault.spanStartPole} (last energized) and pole ${fault.spanEndPole} (first de-energized).`
      );
      lines.push(
        `  Crew should inspect the conductor span between these two poles.`
      );
    } else if (fault.spanEndPole) {
      lines.push(
        `  Fault boundary: at or near root pole ${fault.spanEndPole} (first pole from DT).`
      );
      lines.push(
        `  Crew should inspect the DT LT bushing and the first span from the transformer.`
      );
    }
  }

  lines.push("");

  // ---- Impact ----
  lines.push("📊 IMPACT:");
  lines.push(`  Poles affected: ${fault.affectedPoleCount}`);
  lines.push(`  Estimated households without power: ~${fault.affectedHouseholds}`);
  lines.push(
    `  Confidence: ${(fault.confidence * 100).toFixed(0)}% — ${getConfidenceLabel(fault.confidence)}`
  );

  lines.push("");

  // ---- Crew Instructions ----
  lines.push("🔧 RECOMMENDED ACTIONS:");
  switch (fault.faultType) {
    case "feeder":
      lines.push("  1. Check 11 kV feeder breaker at the substation.");
      lines.push("  2. Patrol the HT line for visible damage (tree fall, insulator failure).");
      lines.push("  3. If no visible damage, check for underground cable fault.");
      lines.push("  4. Coordinate with control room before re-energization.");
      break;
    case "dt":
      lines.push("  1. Check DT LT fuse and HT fuse (drop-out fuse).");
      lines.push("  2. Inspect transformer oil level and look for leaks.");
      lines.push("  3. Check for overload — inspect connected loads.");
      lines.push("  4. If fuse is intact, check transformer winding continuity.");
      break;
    case "span":
      lines.push(`  1. Patrol the span between ${fault.spanStartPole || "DT"} and ${fault.spanEndPole || "unknown"}.`);
      lines.push("  2. Look for: broken conductor, tree contact, insulator damage, loose/burnt joints.");
      lines.push("  3. Check for jumper disconnection at pole connections.");
      lines.push("  4. After repair, verify power restoration on the line.");
      break;
  }

  lines.push("");

  // ---- Safety ----
  lines.push("⚡ SAFETY NOTES:");
  lines.push("  - Assume all conductors are energized until verified dead.");
  lines.push("  - Follow Lock-Out Tag-Out (LOTO) procedure before work.");
  lines.push("  - Use proper PPE (insulating gloves, safety helmet, earthing rod).");
  if (fault.faultType === "feeder") {
    lines.push("  - HT work requires an authorized HT line-man.");
  }

  lines.push("");

  // ---- Confidence explanation ----
  lines.push("📝 DETECTION NOTES:");
  lines.push(`  ${fault.confidenceReason}`);

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  AI dispatch brief (Gemini API)                                             */
/* -------------------------------------------------------------------------- */

export async function generateAIBrief(
  fault: DetectedFault
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.log("[AI Brief] No API key configured, using template brief");
    return generateTemplateBrief(fault);
  }

  try {
    const prompt = buildPrompt(fault);

    // Use Gemini API via the generateContent endpoint
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 800,
          },
        }),
      }
    );

    if (!response.ok) {
      console.warn(
        `[AI Brief] Gemini API error: ${response.status}. Falling back to template.`
      );
      return generateTemplateBrief(fault);
    }

    const data: any = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.warn("[AI Brief] Empty response from Gemini. Falling back to template.");
      return generateTemplateBrief(fault);
    }

    return text.trim();
  } catch (err) {
    console.warn("[AI Brief] API call failed, using template brief:", err);
    return generateTemplateBrief(fault);
  }
}

/* -------------------------------------------------------------------------- */
/*  Prompt builder                                                             */
/* -------------------------------------------------------------------------- */

function buildPrompt(fault: DetectedFault): string {
  return `You are a power distribution dispatch assistant for the Karnataka State Power Distribution Board (KSPDB).

Generate a clear, actionable dispatch brief for a field crew based on this detected fault:

FAULT DATA:
- Type: ${fault.faultType} fault
- Feeder: ${fault.feederId}
- Distribution Transformer: ${fault.dtId}
- Location: ${fault.lat.toFixed(6)}°N, ${fault.lon.toFixed(6)}°E
- PIN Code: ${fault.pincode || "unknown"}
${fault.spanStartPole ? `- Last energized pole: ${fault.spanStartPole}` : ""}
${fault.spanEndPole ? `- First de-energized pole: ${fault.spanEndPole}` : ""}
- Poles affected: ${fault.affectedPoleCount}
- Estimated households affected: ~${fault.affectedHouseholds}
- Detection confidence: ${(fault.confidence * 100).toFixed(0)}%
- Detection reason: ${fault.confidenceReason}

Write a field dispatch brief that includes:
1. A one-line summary of the fault
2. Exact location description for the crew
3. What to inspect (specific components based on the fault type)
4. Step-by-step recommended actions
5. Safety reminders appropriate for the fault type
6. Any caveats based on the detection confidence

Format: Use clear headings and numbered steps. Keep it concise — this will be read on a mobile device by a field crew at 2 AM. No more than 300 words.`;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getConfidenceLabel(c: number): string {
  if (c >= 0.85) return "High confidence — strong signal correlation";
  if (c >= 0.70) return "Good confidence — likely accurate";
  if (c >= 0.50) return "Moderate — verify in field";
  return "Low — multiple possible fault locations";
}
