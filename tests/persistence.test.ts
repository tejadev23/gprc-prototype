import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import type { AppDatabase } from "../lib/db/client";
import * as schema from "../lib/db/schema";
import { users } from "../lib/db/schema";
import { resetMemoryObjects } from "../lib/objects/store";
import { createForOwner, loadForOwner, MissingProject, saveForOwner, StaleRevision, writeFile, readFile } from "../lib/projects/repo";
import { emptyGprcRecord } from "../lib/corridor/storage";

process.env.OBJECT_STORE = "memory";

async function database() {
  const client = new PGlite();
  await client.exec(readFileSync(join(process.cwd(), "drizzle/0001_init.sql"), "utf8"));
  return drizzle(client, { schema }) as unknown as AppDatabase;
}

async function user(db: AppDatabase, email: string) {
  const id = randomUUID();
  await db.insert(users).values({ id, email, passwordHash: "x" });
  return id;
}

test("a password hash verifies only the same password", async () => {
  const stored = await hashPassword("correct horse");
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
  assert.equal(await verifyPassword("correct horse", "not-a-hash"), false);
});

test("projects are private to their owner and stale writes conflict", async () => {
  resetMemoryObjects();
  const db = await database();
  const owner = await user(db, "a@example.com");
  const other = await user(db, "b@example.com");
  const created = await createForOwner(db, owner, "Lakeside");
  created.project.stations = [
    {
      id: "s1",
      name: "20+50",
      stationFt: 2050,
      pageNumber: 3,
      calibration: {
        points: [
          { px: 1, py: 2, offset: 0, elevation: 0 },
          { px: null, py: null, offset: null, elevation: null },
          { px: null, py: null, offset: null, elevation: null },
        ],
        transform: null,
      },
      existing: [{ offset: 0, elevation: 100 }],
      proposed: [{ offset: 1, elevation: 98 }],
      alignmentRef: { centerlineId: null },
    },
  ];
  const revision = await saveForOwner(db, owner, created.project, emptyGprcRecord(), 1, true);
  assert.equal(revision, 2);
  const loaded = await loadForOwner(db, owner, created.project.id);
  assert.equal(loaded?.project.stations[0]?.pageNumber, 3);
  assert.equal(loaded?.project.stations[0]?.existing[0]?.elevation, 100);
  assert.equal(await loadForOwner(db, other, created.project.id), null);
  await assert.rejects(() => saveForOwner(db, owner, created.project, undefined, 1, false), StaleRevision);
  await assert.rejects(() => saveForOwner(db, other, created.project, undefined, 2, false), MissingProject);
});

test("a replaced file keeps the new object when the old one is removed", async () => {
  resetMemoryObjects();
  const db = await database();
  const owner = await user(db, "a@example.com");
  const created = await createForOwner(db, owner, "Plan");
  await writeFile(db, owner, created.project.id, "pdf", Buffer.from("one"), "application/pdf", "a.pdf");
  await writeFile(db, owner, created.project.id, "pdf", Buffer.from("two"), "application/pdf", "b.pdf");
  const file = await readFile(db, owner, created.project.id, "pdf");
  assert.equal(file?.body.toString(), "two");
  assert.equal(await readFile(db, randomUUID(), created.project.id, "pdf"), null);
});
