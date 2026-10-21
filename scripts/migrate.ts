import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");
const sql = postgres(url, { max: 1 });

async function main() {
  const dir = join(process.cwd(), "drizzle");
  await sql`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ id: string }[]>`select id from schema_migrations`).map((row) => row.id));
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    await sql.unsafe(readFileSync(join(dir, name), "utf8"));
    await sql`insert into schema_migrations (id) values (${name})`;
    console.log(`applied ${name}`);
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
