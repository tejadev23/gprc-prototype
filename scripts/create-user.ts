import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hashPassword } from "../lib/auth/password";

function requiredEnv(): { url: string; email: string; password: string } {
  const url = process.env.DATABASE_URL;
  const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_PASSWORD;
  if (!url || !email || !password) throw new Error("Set DATABASE_URL, BOOTSTRAP_EMAIL, and BOOTSTRAP_PASSWORD.");
  return { url, email, password };
}

async function main() {
  const { url, email, password } = requiredEnv();
  const sql = postgres(url, { max: 1 });
  const existing = await sql<{ count: number }[]>`select count(*)::int as count from users`;
  if ((existing[0]?.count ?? 0) > 0 && process.env.BOOTSTRAP_ALLOW_MORE !== "1") {
    throw new Error("An account already exists. Set BOOTSTRAP_ALLOW_MORE=1 to add another.");
  }
  await sql`insert into users (id, email, password_hash) values (${randomUUID()}, ${email}, ${hashPassword(password)})`;
  console.log(`created ${email}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
