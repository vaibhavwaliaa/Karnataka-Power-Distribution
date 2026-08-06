import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { config } from "../config";
import path from "path";

async function runMigrations() {
  console.log("Running database migrations...");
  const isNeon = config.databaseUrl.includes("neon.tech") || config.databaseUrl.includes("sslmode=");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: isNeon ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool);

  await migrate(db, {
    migrationsFolder: path.join(__dirname, "migrations"),
  });

  console.log("Migrations complete.");
  await pool.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
