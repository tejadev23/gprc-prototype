import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type AppDatabase = PostgresJsDatabase<typeof schema>;

let cached: AppDatabase | null = null;

export function getDb(): AppDatabase {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = postgres(url, { max: 5 });
  cached = drizzle(client, { schema });
  return cached;
}
