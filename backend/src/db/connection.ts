import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

const isNeon = config.databaseUrl.includes("neon.tech") || config.databaseUrl.includes("sslmode=");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isNeon ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });
export { pool };
