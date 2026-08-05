import express from "express";
import cors from "cors";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { config } from "./config";
import { loadAllTopology } from "./detection/topology.service";

const app = express();
const server = http.createServer(app);

// Socket.io with CORS for the frontend
export const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH"],
  },
});

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------ */
/*  Health check                                                       */
/* ------------------------------------------------------------------ */

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "KSPDB Fault Localization Backend API" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ------------------------------------------------------------------ */
/*  Route registration (lazy imports to avoid circular deps)           */
/* ------------------------------------------------------------------ */

import { telemetryRouter } from "./ingestion/telemetry.controller";
import { ticketRouter } from "./tickets/ticket.controller";
import { simulatorRouter } from "./simulator/simulator.controller";
import { networkRouter } from "./network/network.controller";
import { scheduledOutageRouter } from "./scheduled-outages/outage.controller";

app.use("/api/telemetry", telemetryRouter);
app.use("/api/tickets", ticketRouter);
app.use("/api/simulator", simulatorRouter);
app.use("/api/network", networkRouter);
app.use("/api/scheduled-outages", scheduledOutageRouter);

/* ------------------------------------------------------------------ */
/*  Socket.io connection                                               */
/* ------------------------------------------------------------------ */

io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);
  socket.on("disconnect", () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
  });
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

async function start() {
  // Load topology into memory before accepting requests
  await loadAllTopology();

  server.listen(config.port, () => {
    console.log(`\n✓ Backend running on port ${config.port}`);
    console.log(`  Health: http://localhost:${config.port}/api/health`);
    console.log(`  Environment: ${config.nodeEnv}\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
