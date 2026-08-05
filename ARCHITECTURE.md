# Architecture

## System Overview

The fault localization system is a three-tier application:

```
   Pole Sensors → [Telemetry Ingest] → [Fault Detection Engine] → [Operator Console]
                        │                       │                        │
                   Dedup + Order          Tree Walk + Score          Map + Tickets
                        │                       │                        │
                   ┌────▼───────────────────────▼────────────────────────▼───┐
                   │                    PostgreSQL                           │
                   │  poles, transformers, telemetry, pole_state, tickets    │
                   └────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Topology Service (`topology.service.ts`)

**Problem:** 60% of poles have no surveyed topology (no `seq_on_line` data).

**Solution:** Dual-mode topology building.

#### Surveyed Topology (40%)
- Poles with `seq_on_line` are ordered by sequence number
- A linked list is built: DT → pole(seq=1) → pole(seq=2) → ...
- This gives exact physical ordering of poles on the line

#### Inferred Topology (60%)
- Uses **Prim's algorithm** to build a Minimum Spanning Tree (MST)
- Distance metric: Haversine formula on GPS coordinates
- The DT is the root, and the MST connects all poles in the cheapest way
- This approximates the physical cable routing (cables follow shortest paths between poles)
- Marked as `topologySource: "inferred"` — confidence scores are reduced

**Why Prim's MST over alternatives?**
- Cables physically follow near-shortest paths between poles
- MST captures this better than Delaunay triangulation or KNN
- O(V²) complexity is fine for ≤120 poles per DT

### 2. Fault Finder (`fault-finder.ts`)

The core algorithm, tested by 32 unit tests. Pure function — no DB or IO.

#### Algorithm: Boundary Walk

```
For each root pole in the DT tree:
  Walk the tree depth-first:
    
    Case 1: DEAD SENSOR
      If this pole is DARK but has LIVE children → impossible fault
      → This is a dead sensor, skip it, continue walking
    
    Case 2: FAULT BOUNDARY  
      If parent is LIVE/UNKNOWN and this pole is DARK
      → Fault detected on the edge (span) between parent and this pole
      → All downstream poles are affected
      → Don't recurse into the dark subtree
    
    Case 3: CONTINUE
      Keep walking children
```

#### Fault Classification

| Type | Condition | Priority |
|------|-----------|----------|
| **Feeder** | All DTs on the feeder are dark | CRITICAL |
| **DT** | All poles under a DT are dark, ≥3 devices confirm | HIGH |
| **Span** | Live→dark boundary on a specific edge | STANDARD |

#### Confidence Scoring

```
confidence = 0.5 (base)
  + 0.25 if surveyed topology (or +0.10 if inferred)
  + (dark_devices / total_devices) × 0.15  // device coverage
  + 0.10 if DT fault with ≥5 confirming devices
  
Clamped to [0.10, 0.99]
```

### 3. Debounce Service (`debounce.service.ts`)

**Problem:** During a mass outage, hundreds of telemetry events arrive within seconds. Running fault detection on every event wastes compute.

**Solution:** Per-DT debounce window.
- When a state change is detected for a DT, start a 3-second timer
- During the window, collect all changed poles
- After the window expires, run fault detection once with all changes
- New changes during the window reset the timer

### 4. State Service (`state.service.ts`)

**Problem:** Telemetry events can arrive out of order and be duplicated.

**Solution:**
- In-memory `Map<poleId, { seq, status }>` for O(1) dedup
- Only apply events with higher `seq` than the last known
- Persist state changes to the `pole_state` table for durability

### 5. Ticket State Machine

```
detected → acknowledged → crew_assigned → resolved → verified → closed
                                              ↑          │
                                              └──────────┘ (if verification fails)
```

**Restoration Verification:** The `resolved` transition checks that all affected poles in the ticket are reporting LIVE via telemetry. If any are still dark, the transition is rejected with a 409 response.

**Auto-Verification:** When a pole transitions to LIVE, the system checks all open tickets that include that pole. If all affected poles are now live, the ticket is automatically moved to `verified`.

### 6. Scheduled Outage Filter

Before creating a ticket, the system checks if the DT or feeder is under a scheduled outage (maintenance window). If yes, the fault is logged but no ticket is created.

### 7. AI Dispatch Brief

Two modes:
- **Template Brief** (always available): Generates structured crew instructions based on fault type, location, and affected area
- **Gemini AI Brief** (optional): Sends fault data to Gemini API for natural-language dispatch instructions

Falls back gracefully: AI → template if no API key or API failure.

## Data Model

```
transformers ──┐
               │ 1:N
poles ─────────┤
  │            │
  │ 1:1        │
pole_state     │
               │
telemetry ─────┘

tickets
  │ 1:N
ticket_affected_poles

scheduled_outages
```

## Real-Time Communication

Socket.io is used for push updates:
- `ticket:created` — new fault detected
- `ticket:updated` — ticket state change or auto-verification
- `poles:updated` — pole state changes (for map markers)
