/**
 * One-time import of GPRC projects from the Earthwork-AI browser database
 * (IndexedDB name: earthwork-corridor) into Postgres for the bootstrap user.
 *
 * Usage:
 *   IDB_PROFILE_DEFAULT="/path/to/browser/Default" pnpm import:idb
 */
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { eq } from "drizzle-orm";
import { normalizeGprcRecord, type EarthworkProject, type GprcRecord } from "../lib/corridor/storage";
import { getDb } from "../lib/db/client";
import { files, gprcRecords, projects, users } from "../lib/db/schema";
import { putObject } from "../lib/objects/store";

const LAST_GPRC_PROJECT_KEY = "lastGprcProjectId";

type MetaEntry = { key: string; value: unknown };
type FileEntry = { id: string; file: { mime: string; base64: string } | null };
type GprcEntry = { id: string; record: GprcRecord };
type ExportBundle = {
  projects: EarthworkProject[];
  meta: MetaEntry[];
  pdfs: FileEntry[];
  plans: FileEntry[];
  gprc: GprcEntry[];
};

function defaultProfileDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set.");
  return join(home, "Library/Application Support/Dia/User Data/Default");
}

function profileUserDataDir(profileDefault: string): { userDataDir: string; cleanup: string | null } {
  if (process.env.IDB_PROFILE_IN_PLACE === "1") {
    const parent = join(profileDefault, "..");
    return { userDataDir: parent, cleanup: null };
  }
  const root = mkdtempSync(join(tmpdir(), "gprc-idb-"));
  const profileDir = join(root, "Default");
  cpSync(profileDefault, profileDir, {
    recursive: true,
    filter: (src) => !src.includes("/Cache") && !src.endsWith("LOCK"),
  });
  return { userDataDir: root, cleanup: root };
}

async function readIndexedDb(profileDefault: string): Promise<ExportBundle> {
  const { userDataDir, cleanup } = profileUserDataDir(profileDefault);
  const origin = process.env.IDB_ORIGIN ?? "http://localhost:3000";
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      channel: process.env.IDB_BROWSER_CHANNEL ?? "chrome",
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const page = await context.newPage();
    const exporter = readFileSync(join(import.meta.dirname, "idb-export.browser.js"), "utf8");
    await context.addInitScript({ content: `${exporter}\nwindow.gprcExportIdb = gprcExportIdb;` });
    await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const bundle = await page.evaluate("window.gprcExportIdb()");
    return bundle as ExportBundle;
  } finally {
    await context?.close({ timeout: 5_000 }).catch(() => undefined);
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

async function writeBinary(projectId: string, kind: "pdf" | "plan", payload: { mime: string; base64: string }, fileName: string | null) {
  const body = Buffer.from(payload.base64, "base64");
  const key = `${projectId}/${kind}/${randomUUID()}`;
  await putObject(key, body, payload.mime);
  const db = getDb();
  await db
    .insert(files)
    .values({ id: randomUUID(), projectId, kind, objectKey: key, mime: payload.mime, byteSize: body.length })
    .onConflictDoUpdate({
      target: [files.projectId, files.kind],
      set: { objectKey: key, mime: payload.mime, byteSize: body.length },
    });
  if (kind === "pdf" && fileName) {
    await db.update(projects).set({ documentStored: true, documentName: fileName }).where(eq(projects.id, projectId));
  }
}

async function importBundle(ownerId: string, bundle: ExportBundle) {
  const db = getDb();
  const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.ownerId, ownerId));
  const taken = new Set(existing.map((row) => row.id));
  let imported = 0;

  for (const project of bundle.projects) {
    const gprcRaw = bundle.gprc.find((row) => row.id === project.id)?.record;
    const gprc = normalizeGprcRecord(gprcRaw);
    if (!taken.has(project.id)) {
      const createdAt = new Date(project.createdAt);
      const updatedAt = new Date(project.updatedAt);
      await db.transaction(async (tx) => {
        await tx.insert(projects).values({
          id: project.id,
          ownerId,
          name: project.name,
          createdAt,
          updatedAt,
          schemaVersion: project.version ?? 1,
          revision: 1,
          activeStationId: project.activeStationId,
          pageNumber: project.pageNumber ?? 1,
          documentName: project.document?.name ?? null,
          documentStored: project.document?.stored === true,
          visibility: project.visibility,
          dockTab: project.dockTab,
          snap: project.snap === true,
          stations: project.stations,
        });
        await tx.insert(gprcRecords).values({ projectId: project.id, record: gprc });
      });
      imported += 1;
    } else {
      await db
        .insert(gprcRecords)
        .values({ projectId: project.id, record: gprc })
        .onConflictDoUpdate({ target: gprcRecords.projectId, set: { record: gprc } });
    }

    const pdf = bundle.pdfs.find((row) => row.id === project.id)?.file;
    if (pdf) await writeBinary(project.id, "pdf", pdf, project.document?.name ?? null);
    const plan = bundle.plans.find((row) => row.id === project.id)?.file;
    if (plan) await writeBinary(project.id, "plan", plan, gprc.planFileName);

    console.log(
      `${taken.has(project.id) ? "updated" : "imported"} ${project.name} (${project.stations.length} stations, pdf=${pdf ? "yes" : "no"}, plan=${plan ? "yes" : "no"})`,
    );
  }

  const lastGprc = bundle.meta.find((row) => row.key === LAST_GPRC_PROJECT_KEY)?.value;
  if (typeof lastGprc === "string" && bundle.projects.some((p) => p.id === lastGprc)) {
    await db.update(users).set({ lastProjectId: lastGprc }).where(eq(users.id, ownerId));
  } else if (bundle.projects.length > 0) {
    const newest = [...bundle.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
    await db.update(users).set({ lastProjectId: newest.id }).where(eq(users.id, ownerId));
  }

  console.log(`Done. Imported ${imported} project(s).`);
}

async function main() {
  const profileDefault = process.env.IDB_PROFILE_DEFAULT ?? defaultProfileDir();
  const ownerEmail = (process.env.IMPORT_OWNER_EMAIL ?? "admin@gmail.com").trim().toLowerCase();
  const db = getDb();
  const ownerRows = await db.select().from(users).where(eq(users.email, ownerEmail)).limit(1);
  const owner = ownerRows[0];
  if (!owner) throw new Error(`No user found for ${ownerEmail}.`);

  console.log(`Reading IndexedDB from ${profileDefault}`);
  const bundle = await readIndexedDb(profileDefault);
  const debug = bundle as ExportBundle & { catalog?: { name?: string; version?: number }[]; stores?: string[] };
  if (debug.catalog) console.log("IndexedDB catalog:", JSON.stringify(debug.catalog));
  if (debug.stores) console.log("earthwork-corridor stores:", debug.stores.join(", "));
  console.log(`Found ${bundle.projects.length} project(s) in earthwork-corridor`);
  if (bundle.projects.length === 0) return;
  await importBundle(owner.id, bundle);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
