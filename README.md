# KSPDB Fault Localization System

Real-time power outage detection, span-level fault localization, and telemetry auto-verification system built for the **Karnataka State Power Distribution Board (KSPDB)**. Automatically processes telemetry events from ~4,000 utility poles to identify broken line spans, group dark pole alerts, filter false alarms, and verify power restoration.

---

## ⚡ Quick Start (One-Command Launch)

```bash
# 1. Copy environment configuration
cp .env.example .env

# 2. Start all services using Docker Compose
docker compose up --build -d

# 3. Access the application:
#    Operator Console UI:  http://localhost:5173
#    Backend Health Check: http://localhost:3001/api/health
```

On initial startup, the backend automatically seeds ~4,000 poles across 80 distribution transformers and 31 feeders, builds spatial topology trees (surveyed + Prim's MST), and launches the control room dashboard.

---

## Key Features

1. **Telemetry Ingestion & Ordering**:
   Ingests IoT sensor packets (`power_lost`, `power_restored`, `heartbeat`, `boot`) with sequence-number (`seq`) deduplication to handle out-of-order delivery, firmware 1.2 silence, and burst telemetry.

2. **Fault Localization & Boundary Walk**:
   Traverses radial distribution trees depth-first to pinpoint exact live-to-dark boundaries (span faults), DT-level disconnects, and 11 kV feeder outages.

3. **Missing Topology Solution (60% Case)**:
   Uses surveyed sequence data where available (40%), and automatically constructs **Prim's Minimum Spanning Tree (MST)** on Haversine GPS coordinates for unsurveyed lines (60%), communicating confidence scores transparently.

4. **False Alarm & Noise Filtering ("Don't Cry Wolf")**:
   - **Dead Sensor Detection**: Ignores dark poles that have live children downstream (sensor hardware failure, not a physical line cut).
   - **Scheduled Outage Integration**: Filters out outages occurring during planned maintenance windows.

5. **Telemetry Auto-Verification & Ticket Lifecycle**:
   Rejects manual ticket resolution if telemetry reports dark poles. Automatically verifies and closes tickets once live telemetry confirms power restoration across all affected poles.

6. **Control Room Console & Fault Simulator**:
   - **Interactive Leaflet Map**: Real-time visualization of network assets, active fault boundaries, and affected poles.
   - **AI Dispatch Briefs**: Generates field crew instructions via Gemini AI with an offline template fallback.
   - **Interactive Simulator**: Allows instant injection of span faults, DT outages, feeder cuts, dead sensor noise, scheduled outages, and repair telemetry.

---

## Documentation Map

- **[`ARCHITECTURE.md`](ARCHITECTURE.md)**: Deep dive into the tree-walking localization algorithm, Prim's MST graph math, database schema, data flow diagram, and UI design reasoning.
- **[`DEPLOYMENT.md`](DEPLOYMENT.md)**: Deployment steps, environment variable specification, data volume reset instructions, and a detailed **Troubleshooting Guide** for common container/port issues.
- **[`DECISIONS.md`](DECISIONS.md)**: Log of 10 key engineering trade-offs, architecture choices, and rationale.
- **[`AI-WORKFLOW.md`](AI-WORKFLOW.md)**: AI pair-programming log detailing what was delegated vs manually written, code attribution estimates, and 3 concrete AI mistake cases caught and corrected.

---

## Local Development & Unit Testing

### Running Unit Tests (No DB or Docker required)
```bash
cd backend
npm install
npm test
```
Runs 32 Vitest unit tests verifying span fault detection, DT faults, feeder outages, dead sensor suppression, and restoration verification edge cases.

### Local Development Setup
```bash
# Terminal 1: Backend
cd backend
npm install
npm run dev

# Terminal 2: Frontend
cd frontend
npm install
npm run dev
```

---

## System Requirements

- Docker & Docker Compose (v2+)
- Node.js 20+ (for local development outside Docker)
