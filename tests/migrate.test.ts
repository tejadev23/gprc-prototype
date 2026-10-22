import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyGprcRecord, type EarthworkProject, type GprcRecord } from "../lib/corridor/storage";
import type { AppDatabase } from "../lib/db/client";
import * as schema from "../lib/db/schema";
import { gprcRecords, projects, users } from "../lib/db/schema";
import { sha256Hex } from "../lib/migrate/hash";
import { packMigrationZip, unpackMigrationZip } from "../lib/migrate/zip";
import { MAX_UPLOAD_BYTES } from "../lib/objects/limits";
import { importProjectsForOwner } from "../lib/projects/import";
import { loadForOwner } from "../lib/projects/repo";

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

function sampleProject(overrides?: Partial<EarthworkProject>): EarthworkProject {
  const stationId = "11111111-1111-4111-8111-111111111111";
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "North Corridor",
    createdAt: "2024-01-02T03:04:05.000Z",
    updatedAt: "2024-02-03T04:05:06.000Z",
    version: 1,
    activeStationId: stationId,
    pageNumber: 2,
    document: { name: "sections.pdf", stored: true },
    visibility: { existing: true, proposed: true, cut: false, fill: true },
    dockTab: "cutfill",
    snap: true,
    stations: [
      {
        id: stationId,
        name: "10+50",
        stationFt: 1050,
        pageNumber: 2,
        calibration: {
          points: [
            { px: 10, py: 20, offset: 0, elevation: 100 },
            { px: 30, py: 20, offset: 50, elevation: 100 },
            { px: 10, py: 40, offset: 0, elevation: 90 },
          ],
          transform: { ox: 10, oy: 20, sx: 0.4, sy: -0.5 },
        },
        existing: [
          { offset: 0, elevation: 100 },
          { offset: 12, elevation: 99 },
        ],
        proposed: [{ offset: 0, elevation: 98 }],
        alignmentRef: { centerlineId: null },
      },
    ],
    ...overrides,
  };
}

function sampleGprc(): GprcRecord {
  const record = emptyGprcRecord();
  record.planFileName = "mainline.png";
  record.planMime = "image/png";
  record.alignment = {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    draft: [],
    rasterWidth: 200,
    rasterHeight: 100,
    markers: [{ id: "marker-1", label: "10+50", stationFt: 1050, distancePx: 40, stationId: "11111111-1111-4111-8111-111111111111" }],
  };
  record.georef = {
    crs: { code: "EPSG:2240", units: "ft-us", verified: true },
    points: [{ id: "cp-1", name: "N1", px: 5, py: 6, easting: 1, northing: 2 }],
    method: "similarity",
    raster: { width: 200, height: 100 },
    vertical: { datum: "NAVD88", units: "ft-us" },
  };
  return record;
}

function item(project = sampleProject(), gprc = sampleGprc(), files?: { pdf?: { path: string; byteSize: number; sha256: string; mime: string } | null }) {
  return { project, gprc, files };
}

test("a migration zip round-trips project JSON, raw files, sizes, and hashes", async () => {
  const project = sampleProject();
  const gprc = sampleGprc();
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
  const plan = new Uint8Array([137, 80, 78, 71]);
  const packed = packMigrationZip(
    [
      {
        meta: {
          id: project.id,
          name: project.name,
          stationCount: 1,
          alignmentMarkerCount: 1,
          georefPointCount: 1,
          files: {
            pdf: { path: `files/${project.id}/pdf`, byteSize: pdf.byteLength, sha256: await sha256Hex(pdf), mime: "application/pdf" },
            plan: { path: `files/${project.id}/plan`, byteSize: plan.byteLength, sha256: await sha256Hex(plan), mime: "image/png" },
          },
        },
        payload: { project, gprc },
        files: { pdf, plan },
      },
    ],
    "http://localhost:3000",
    "2026-01-01T00:00:00.000Z",
  );
  const unpacked = await unpackMigrationZip(packed, sha256Hex);
  assert.equal(unpacked.manifest.origin, "http://localhost:3000");
  assert.equal(unpacked.projects[0]?.payload.project.stations[0]?.id, project.stations[0]?.id);
  assert.equal(unpacked.projects[0]?.payload.gprc.alignment.markers[0]?.id, "marker-1");
  assert.equal(unpacked.projects[0]?.payload.gprc.georef?.points[0]?.id, "cp-1");
  assert.deepEqual(unpacked.projects[0]?.files.pdf, pdf);
  assert.deepEqual(unpacked.projects[0]?.files.plan, plan);
});

test("import inserts the original UUID and preserves stations, traces, calibration, and GPRC ids", async () => {
  const db = await database();
  const owner = await user(db, "owner@example.com");
  const project = sampleProject();
  const gprc = sampleGprc();
  const preview = await importProjectsForOwner(db, owner, [item(project, gprc)], { apply: false });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.results[0]?.action, "import");
  assert.equal((await db.select().from(projects)).length, 0);

  const applied = await importProjectsForOwner(db, owner, [item(project, gprc)], { apply: true });
  assert.equal(applied.results[0]?.action, "import");
  const loaded = await loadForOwner(db, owner, project.id);
  assert.equal(loaded?.revision, 1);
  assert.equal(loaded?.project.id, project.id);
  assert.equal(loaded?.project.createdAt, project.createdAt);
  assert.equal(loaded?.project.stations[0]?.id, project.stations[0]?.id);
  assert.equal(loaded?.project.stations[0]?.existing[1]?.elevation, 99);
  assert.equal(loaded?.project.stations[0]?.calibration.transform?.sx, 0.4);
  assert.equal(loaded?.gprc.alignment.markers[0]?.stationId, project.stations[0]?.id);
  assert.equal(loaded?.gprc.georef?.points[0]?.id, "cp-1");
  assert.equal(loaded?.project.document.stored, false);
});

test("an existing id is skipped on retry and refused for another owner", async () => {
  const db = await database();
  const owner = await user(db, "owner@example.com");
  const other = await user(db, "other@example.com");
  const project = sampleProject();
  await importProjectsForOwner(db, owner, [item(project)], { apply: true });

  const retry = await importProjectsForOwner(db, owner, [item({ ...project, name: "Changed" })], { apply: true });
  assert.equal(retry.results[0]?.action, "skip");
  const loaded = await loadForOwner(db, owner, project.id);
  assert.equal(loaded?.project.name, "North Corridor");

  const foreign = await importProjectsForOwner(db, other, [item(project)], { apply: true });
  assert.equal(foreign.results[0]?.action, "fail");
  assert.equal(foreign.results[0]?.reason, "This project id is not available.");
  assert.equal(await loadForOwner(db, other, project.id), null);
});

test("overwrite requires an explicit id and still checks ownership", async () => {
  const db = await database();
  const owner = await user(db, "owner@example.com");
  const other = await user(db, "other@example.com");
  const project = sampleProject();
  await importProjectsForOwner(db, owner, [item(project)], { apply: true });

  const renamed = sampleProject({ name: "Renamed" });
  const withoutConfirm = await importProjectsForOwner(db, owner, [item(renamed)], { apply: true, overwriteIds: [] });
  assert.equal(withoutConfirm.results[0]?.action, "skip");

  const withConfirm = await importProjectsForOwner(db, owner, [item(renamed)], { apply: true, overwriteIds: [project.id] });
  assert.equal(withConfirm.results[0]?.action, "overwrite");
  assert.equal((await loadForOwner(db, owner, project.id))?.project.name, "Renamed");

  const stolen = await importProjectsForOwner(db, other, [item(project)], { apply: true, overwriteIds: [project.id] });
  assert.equal(stolen.results[0]?.action, "fail");
});

test("invalid payloads fail that item and files over 40 MB are rejected", async () => {
  const db = await database();
  const owner = await user(db, "owner@example.com");
  const invalid = await importProjectsForOwner(db, owner, [{ project: { name: "Nope" }, gprc: sampleGprc() }], { apply: true });
  assert.equal(invalid.results[0]?.action, "fail");
  assert.match(invalid.results[0]?.reason ?? "", /UUID/);

  const project = sampleProject();
  const large = await importProjectsForOwner(
    db,
    owner,
    [
      item(project, sampleGprc(), {
        pdf: { path: `files/${project.id}/pdf`, byteSize: MAX_UPLOAD_BYTES + 1, sha256: "a".repeat(64), mime: "application/pdf" },
      }),
    ],
    { apply: true },
  );
  assert.equal(large.results[0]?.action, "import");
  assert.equal(large.results[0]?.files.pdf.action, "reject");
  assert.equal(large.results[0]?.files.pdf.reason, "That file is larger than 40 MB.");
  const rows = await db.select().from(gprcRecords).where(eq(gprcRecords.projectId, project.id));
  assert.equal(rows.length, 1);
});

test("a retry after a successful insert does not duplicate rows", async () => {
  const db = await database();
  const owner = await user(db, "owner@example.com");
  const project = sampleProject();
  await importProjectsForOwner(db, owner, [item(project)], { apply: true });
  await importProjectsForOwner(db, owner, [item(project)], { apply: true });
  const rows = await db.select().from(projects).where(eq(projects.id, project.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.revision, 1);
});
