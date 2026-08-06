import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://faultuser:faultpass@localhost:5432/faultdb",
  nodeEnv: process.env.NODE_ENV || "development",
  openaiApiKey: process.env.OPENAI_API_KEY || "",

  // Fault detection tuning
  debounceWindowMs: parseInt(process.env.DEBOUNCE_WINDOW_MS || "25000", 10), // 25s
  heartbeatIntervalMs: 15 * 60 * 1000, // 15 minutes
  heartbeatTimeoutMs: 18 * 60 * 1000, // 18 minutes (15 + jitter + buffer)
  scheduledOutageBufferMs: 45 * 60 * 1000, // 45 min past scheduled end
  staleMessageThresholdMs: 6 * 60 * 60 * 1000, // 6 hours

  // Performance
  ingestBatchSize: 100,
};
