# Engineering Decisions

Key trade-offs and rationale for the fault localization system.

---

## 1. Prim's MST for Missing Topology

**Decision:** Use Prim's algorithm on GPS coordinates to infer pole topology when survey data (`seq_on_line`) is missing.

**Alternatives considered:**
- **K-Nearest Neighbors (KNN):** Connects each pole to its K closest neighbors. Problem: creates cycles and doesn't produce a tree structure needed for fault boundary detection.
- **Delaunay Triangulation:** Produces planar graph from GPS points. Problem: too many connections (graph, not tree), and pole connections follow streets, not Voronoi cells.
- **Linear ordering by distance from DT:** Sort poles by distance and chain them. Problem: doesn't capture branching, which is common in LT distribution.

**Why MST wins:**
- LT cables follow physical shortest paths between poles (cost optimization)
- MST naturally produces a tree — exactly what the fault walker needs
- O(V²) with Prim's is fine for ≤120 poles per DT (typical max)
- Branching is preserved when multiple poles are equidistant

**Trade-off:** MST approximates cable routing but can't capture planned detours. Inferred topology gets a lower confidence score (0.60 base vs 0.75 for surveyed).

---

## 2. Debounce over Rate Limiting

**Decision:** Per-DT debounce window (3s) before running fault detection.

**Alternative:** Rate-limit to one detection per 30s globally.

**Why debounce wins:**
- During a mass outage, events arrive over 5-15 seconds as pole sensors die in cascade
- Global rate limiting would either run detection too early (missing events) or too late
- Per-DT debounce lets each transformer area stabilize independently
- Resettable timer means the window extends if events keep arriving
- Force-flush available for the simulator (instant detection in demos)

---

## 3. Dead Sensor Detection via Physical Impossibility

**Decision:** A dark pole with live children is flagged as a dead sensor, not a fault.

**Rationale:** Power flows from DT → root → leaves. If pole P3 is dark but its children (P5, P6) are live, that's physically impossible for a line fault — power can't jump over a de-energized conductor. The only explanation is that P3's sensor/device is malfunctioning.

**Action:** Dead sensors are logged but don't generate tickets. The fault walker continues past them, treating the pole as "live" for boundary detection purposes.

---

## 4. Template-First AI with Graceful Fallback

**Decision:** AI dispatch briefs are optional. A comprehensive template-based brief is always generated first.

**Alternatives:**
- **AI-only:** Relies on API availability and adds latency
- **No AI:** Misses the assignment requirement

**Why template-first:**
- System must work at 2 AM during a storm — API outages are likely
- Template briefs are domain-specific and cover all fault types with correct crew instructions
- AI adds value for nuance and natural language but isn't critical path
- No LLM in the hot path — AI is called on-demand per ticket, not during detection

---

## 5. In-Memory State with DB Persistence

**Decision:** `pole_state` is maintained in an in-memory Map AND persisted to PostgreSQL.

**Why not DB-only:**
- Telemetry dedup requires O(1) lookup by poleId + seq number
- DB round-trip per event would be 50-100ms — unacceptable at 4000+ events/minute during mass outages
- In-memory map gives sub-microsecond lookup

**Why not memory-only:**
- Process restart would lose all state
- The `pole_state` table serves as the source of truth for fault detection and the frontend map

**Trade-off:** Potential 3-second staleness between memory and DB during burst writes. Acceptable because fault detection uses the in-memory view anyway.

---

## 6. Restoration Verification via Telemetry

**Decision:** Tickets cannot be marked "resolved" unless telemetry confirms all affected poles are live.

**Alternative:** Allow manual resolution without verification.

**Why telemetry verification:**
- Prevents premature closure — field crew reports "fixed" but a downstream pole is still dark
- Reduces truck rolls for re-repairs
- Auto-verification feature means tickets close automatically when power is truly restored, even if the crew doesn't update the ticket

**Trade-off:** Poles without devices (9%) can't be verified. We assume them "OK" since we can't know their state.

---

## 7. Minimum 3-Device Threshold for DT Faults

**Decision:** Require ≥3 devices reporting dark to confirm a DT-level fault.

**Rationale:** With 9% of poles having no device, a small DT with 2-3 dark devices could be coincident device failures rather than a transformer fault. The 3-device minimum reduces false positives.

---

## 8. Express + tsx in Docker (No Build Step)

**Decision:** Run TypeScript directly via `tsx` in the Docker container instead of compiling to JavaScript.

**Why:**
- Eliminates the problem of copying non-TS files (SQL migrations) to `dist/`
- Express.js is I/O-bound, not CPU-bound — tsx overhead is negligible
- Simpler Dockerfile with fewer moving parts
- Dev and production use the same execution path

---

## 9. Synthetic Data Generator

**Decision:** Generate realistic data programmatically rather than loading CSV fixtures.

**Why:**
- Assignment specs exact proportions: 60% no topology, 9% no device, 3% no pincode
- Generator guarantees these proportions every time
- GPS coordinates are bounded to Bangalore area with realistic clustering
- Idempotent: checks for existing data before seeding
- Configurable: 80 DTs × ~50 poles = ~4000 poles (enough to exercise algorithms, fast to seed)

---

## 10. Socket.io for Real-Time Updates

**Decision:** Use Socket.io over Server-Sent Events (SSE) or polling.

**Why Socket.io:**
- Bidirectional — future features could let the operator send commands
- Built-in reconnection and fallback (WebSocket → polling)
- Room-based broadcasting for per-DT subscriptions (future)
- Well-supported in React ecosystem

**Why not SSE:** One-directional only, no native reconnection in all browsers.
**Why not polling:** Inefficient for real-time fault detection display.
