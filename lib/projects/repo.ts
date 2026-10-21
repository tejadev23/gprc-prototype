import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { emptyGprcRecord, normalizeGprcRecord, type EarthworkProject, type GprcRecord, type ProjectSummary } from "@/lib/corridor/storage";
import type { AppDatabase } from "@/lib/db/client";
import { files, gprcRecords, projects, users } from "@/lib/db/schema";
import { deleteObject, getObject, putObject } from "@/lib/objects/store";
import { duplicateName } from "@/lib/corridor/storage";

export class MissingProject extends Error {}
export class StaleRevision extends Error {
  constructor(readonly revision: number) {
    super("stale");
  }
}

type Database = AppDatabase;

function rowToProject(row: typeof projects.$inferSelect): EarthworkProject {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.schemaVersion,
    stations: row.stations as EarthworkProject["stations"],
    activeStationId: row.activeStationId,
    pageNumber: row.pageNumber,
    document: { name: row.documentName, stored: row.documentStored },
    visibility: row.visibility as EarthworkProject["visibility"],
    dockTab: row.dockTab as EarthworkProject["dockTab"],
    snap: row.snap,
  };
}

async function owned(db: Database, ownerId: string, id: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOwner(db: Database, ownerId: string): Promise<ProjectSummary[]> {
  const rows = await db.select().from(projects).where(eq(projects.ownerId, ownerId));
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.schemaVersion,
      stationCount: Array.isArray(row.stations) ? row.stations.length : 0,
      documentName: row.documentName,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadForOwner(db: Database, ownerId: string, id: string) {
  const row = await owned(db, ownerId, id);
  if (!row) return null;
  const gprcRows = await db.select().from(gprcRecords).where(eq(gprcRecords.projectId, id)).limit(1);
  return {
    project: rowToProject(row),
    gprc: gprcRows[0] ? normalizeGprcRecord(gprcRows[0].record as Partial<GprcRecord>) : emptyGprcRecord(),
    revision: row.revision,
  };
}

export async function createForOwner(db: Database, ownerId: string, name: string): Promise<{ project: EarthworkProject; revision: number }> {
  const now = new Date();
  const id = randomUUID();
  const project = {
    id,
    name: name.trim() || "Untitled Earthwork Project",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
    stations: [],
    activeStationId: null,
    pageNumber: 1,
    document: { name: null, stored: false },
    visibility: { existing: true, proposed: true, cut: true, fill: true },
    dockTab: "volume" as const,
    snap: false,
  };
  await db.transaction(async (tx) => {
    await tx.insert(projects).values({
      id,
      ownerId,
      name: project.name,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      revision: 1,
      activeStationId: null,
      pageNumber: 1,
      documentName: null,
      documentStored: false,
      visibility: project.visibility,
      dockTab: "volume",
      snap: false,
      stations: [],
    });
    await tx.insert(gprcRecords).values({ projectId: id, record: emptyGprcRecord() });
    await tx.update(users).set({ lastProjectId: id }).where(eq(users.id, ownerId));
  });
  return { project, revision: 1 };
}

export async function saveForOwner(
  db: Database,
  ownerId: string,
  project: EarthworkProject,
  gprc: GprcRecord | undefined,
  expectedRevision: number,
  touchLast: boolean,
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, project.id), eq(projects.ownerId, ownerId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new MissingProject();
    if (row.revision !== expectedRevision) throw new StaleRevision(row.revision);
    const next = row.revision + 1;
    const now = new Date();
    await tx
      .update(projects)
      .set({
        name: project.name,
        updatedAt: now,
        revision: next,
        activeStationId: project.activeStationId,
        pageNumber: project.pageNumber,
        documentName: project.document.name,
        visibility: project.visibility,
        dockTab: project.dockTab,
        snap: project.snap,
        stations: project.stations,
      })
      .where(eq(projects.id, project.id));
    if (gprc) {
      await tx
        .insert(gprcRecords)
        .values({ projectId: project.id, record: gprc })
        .onConflictDoUpdate({ target: gprcRecords.projectId, set: { record: gprc } });
    }
    if (touchLast) await tx.update(users).set({ lastProjectId: project.id }).where(eq(users.id, ownerId));
    return next;
  });
}

export async function lastProjectFor(db: Database, ownerId: string): Promise<string | null> {
  const rows = await db.select({ lastProjectId: users.lastProjectId }).from(users).where(eq(users.id, ownerId)).limit(1);
  return rows[0]?.lastProjectId ?? null;
}

export async function rememberProject(db: Database, ownerId: string, id: string): Promise<void> {
  const row = await owned(db, ownerId, id);
  if (!row) throw new MissingProject();
  await db.update(users).set({ lastProjectId: id }).where(eq(users.id, ownerId));
}

export async function removeForOwner(db: Database, ownerId: string, id: string): Promise<boolean> {
  const row = await owned(db, ownerId, id);
  if (!row) return false;
  const stored = await db.select().from(files).where(eq(files.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
  await db.update(users).set({ lastProjectId: null }).where(and(eq(users.id, ownerId), eq(users.lastProjectId, id)));
  for (const file of stored) {
    try {
      await deleteObject(file.objectKey);
    } catch {
      // The row is already gone, so the object is no longer reachable. A later bucket sweep can remove it.
    }
  }
  return true;
}

async function copyObject(sourceKey: string, destKey: string, mime: string): Promise<void> {
  const object = await getObject(sourceKey);
  if (!object) throw new Error("A project file is missing from storage.");
  await putObject(destKey, object.body, mime);
}

export async function duplicateForOwner(db: Database, ownerId: string, id: string): Promise<EarthworkProject | null> {
  const loaded = await loadForOwner(db, ownerId, id);
  if (!loaded) return null;
  const names = (await listForOwner(db, ownerId)).map((item) => item.name);
  const created = await createForOwner(db, ownerId, duplicateName(loaded.project.name, names));
  const copy = { ...loaded.project, id: created.project.id, name: created.project.name, createdAt: created.project.createdAt, updatedAt: created.project.updatedAt };
  await saveForOwner(db, ownerId, copy, loaded.gprc, 1, false);
  const stored = await db.select().from(files).where(eq(files.projectId, id));
  const written: string[] = [];
  try {
    for (const file of stored) {
      const key = `${created.project.id}/${file.kind}/${randomUUID()}`;
      await copyObject(file.objectKey, key, file.mime);
      written.push(key);
      await db.insert(files).values({
        id: randomUUID(),
        projectId: created.project.id,
        kind: file.kind,
        objectKey: key,
        mime: file.mime,
        byteSize: file.byteSize,
      });
      if (file.kind === "pdf") {
        await db.update(projects).set({ documentStored: true, documentName: copy.document.name }).where(eq(projects.id, created.project.id));
      }
    }
  } catch (error) {
    await removeForOwner(db, ownerId, created.project.id);
    for (const key of written) {
      try {
        await deleteObject(key);
      } catch {
        // The project row is gone. The object is unreachable.
      }
    }
    throw error;
  }
  return { ...copy, document: { ...copy.document, stored: stored.some((file) => file.kind === "pdf") } };
}

export async function writeFile(
  db: Database,
  ownerId: string,
  projectId: string,
  kind: "pdf" | "plan",
  body: Buffer,
  mime: string,
  fileName: string | null,
): Promise<void> {
  if (!(await owned(db, ownerId, projectId))) throw new MissingProject();
  const key = `${projectId}/${kind}/${randomUUID()}`;
  await putObject(key, body, mime);
  const previous = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.kind, kind)))
    .limit(1);
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(files)
        .values({ id: randomUUID(), projectId, kind, objectKey: key, mime, byteSize: body.length })
        .onConflictDoUpdate({
          target: [files.projectId, files.kind],
          set: { objectKey: key, mime, byteSize: body.length },
        });
      if (kind === "pdf") {
        await tx.update(projects).set({ documentStored: true, documentName: fileName }).where(eq(projects.id, projectId));
      }
    });
  } catch (error) {
    await deleteObject(key);
    throw error;
  }
  const oldKey = previous[0]?.objectKey;
  if (oldKey && oldKey !== key) {
    try {
      await deleteObject(oldKey);
    } catch {
      // The database already points at the new object.
    }
  }
}

export async function readFile(db: Database, ownerId: string, projectId: string, kind: "pdf" | "plan") {
  if (!(await owned(db, ownerId, projectId))) return null;
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.kind, kind)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const object = await getObject(row.objectKey);
  if (!object) return null;
  return { body: object.body, mime: row.mime };
}

export async function clearFile(db: Database, ownerId: string, projectId: string, kind: "pdf" | "plan"): Promise<void> {
  if (!(await owned(db, ownerId, projectId))) throw new MissingProject();
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.projectId, projectId), eq(files.kind, kind)))
    .limit(1);
  await db.delete(files).where(and(eq(files.projectId, projectId), eq(files.kind, kind)));
  if (kind === "pdf") await db.update(projects).set({ documentStored: false }).where(eq(projects.id, projectId));
  if (rows[0]) {
    try {
      await deleteObject(rows[0].objectKey);
    } catch {
      // Unreachable after the row is gone.
    }
  }
}
