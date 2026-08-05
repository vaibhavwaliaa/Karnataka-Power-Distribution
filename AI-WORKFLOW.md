# AI Workflow & Pair Programming Log

This document details how AI tools (Google Antigravity / Gemini) were used during the engineering of the KSPDB Fault Localization system, what was delegated vs manually written, and cases where AI output was incorrect and corrected.

---

## 1. How AI Was Used

### What I Delegated to AI
- Scaffolding the Express + React + Docker project boilerplate.
- Writing initial Drizzle ORM schema definitions and database connection code.
- Drafting unit test cases for tree structure edge cases in `fault-finder.test.ts`.
- Building UI boilerplate for Leaflet map integration and TailwindCSS styling.

### What I Designed & Wrote Manually
- **Core Fault Localization Logic (`fault-finder.ts`)**: Designed the recursive live-to-dark frontier algorithm and dead sensor suppression logic.
- **Missing Topology Strategy (`topology.service.ts`)**: Decided on Prim's Minimum Spanning Tree (MST) using Haversine distances to approximate the physical cable layout for the 60% unsurveyed transformers.
- **Telemetry State Machine (`ticket.controller.ts`)**: Formulated the strict auto-verification rule — tickets cannot transition to `resolved` unless live telemetry confirms all affected poles are energized.

---

## 2. Concrete Cases Where AI Was Wrong or Misleading

### Case 1: Recommending LLM for Graph Fault Localization
* **What AI did**: Initially suggested sending pole status JSON to an LLM prompt to identify the fault boundary.
* **Why it was wrong**: Reaching for an LLM to perform tree graph traversal is slow, non-deterministic, expensive, and non-explainable.
* **How I caught & fixed it**: Rejected the suggestion immediately. Implemented a pure, deterministic depth-first tree traversal (`findSpanFaults`) that completes in sub-millisecond time, costs $0, and is verified by 32 unit tests.

### Case 2: Silent Dropping of Telemetry on Device `boot` Events
* **What AI did**: Generated a sequence deduplication rule `if (seq <= lastSeq) return "duplicate"`.
* **Why it was wrong**: When an IoT device reboots or recovers from an outage, its internal `seq` counter resets to 0. Under the AI's rule, all `boot` and subsequent `power_restored` packets were treated as duplicate/stale and silently dropped.
* **How I caught & fixed it**: Discovered when test telemetry for device recovery failed to update pole states. Modified `state.service.ts` to explicitly allow `boot` events to pass through and reset the in-memory sequence tracker.

### Case 3: Fixed Host Port Bindings in Docker Compose
* **What AI did**: Generated `docker-compose.yml` with hardcoded `5432:5432` port mapping for PostgreSQL.
* **Why it was wrong**: On machines running a local PostgreSQL instance, `docker compose up` crashed with `Bind for 0.0.0.0:5432 failed: port is already allocated`.
* **How I caught & fixed it**: Hit the port collision during local docker testing. Updated `docker-compose.yml` and `.env.example` to use configurable `DB_PORT` (`${DB_PORT:-5433}:5432`).

---

## 3. Code Attribution Estimate

- **~40% AI-Generated**: Project scaffolding, Drizzle schema templates, React boilerplate components, and Vitest test boilerplate.
- **~60% Human Written / Refactored**: Core fault-finder algorithm, Prim's MST tree builder, telemetry deduplication state machine, restoration auto-verification logic, and error handling.

---

## 4. Prompting Highlights & Excerpts

> **Prompt for Dead Sensor Detection:**
> *"If pole P3 reports dark but its child poles P5 and P6 are live, what does that mean physically on a radial distribution line?"*
>
> **Outcome:** Guided the AI to implement Case 1 in `findFaultsRecursive`: dark poles with live children represent sensor hardware failure, not a line cut, and must be skipped without triggering false outage alerts.

