import { eq } from "drizzle-orm";
import { emptyGprcRecord, type EarthworkProject, type GprcRecord } from "@/lib/corridor/storage";
import type { AppDatabase } from "@/lib/db/client";
import { files, gprcRecords, projects } from "@/lib/db/schema";
import { alignmentMarkerCount, georefPointCount, stationCount } from "@/lib/migrate/counts";
import { isSha256Hex } from "@/lib/migrate/hash";
import type {
  HostedFileMeta,
  ImportFilePlan,
  ImportItemResult,
  ImportReport,
  MigrationFileMeta,
} from "@/lib/migrate/types";
import { MAX_UPLOAD_BYTES } from "@/lib/objects/limits";
import { BadProjectData, parseGprcBody, parseImportedProject, UUID_RE } from "./validate";

type Database = AppDatabase;

export type ImportItemInput = {
  project: unknown;
  gprc?: unknown;
  files?: {
    pdf?: MigrationFileMeta | null;
    plan?: MigrationFileMeta | null;
  };
};

export type ImportOptions = {
  apply: boolean;
  overwriteIds?: string[];
  origin?: string | null;
};

function fileTooLargeMessage(): string {
  return "That file is larger than 40 MB.";
}

function emptyFilePlan(incoming: MigrationFileMeta | null, hosted: HostedFileMeta | null): ImportFilePlan {
  return { incoming, hosted, action: incoming ? "reject" : "none", reason: incoming ? "Project was not imported." : null };
}

function planFile(incoming: MigrationFileMeta | null, hosted: HostedFileMeta | null, overwrite: boolean): ImportFilePlan {
  if (!incoming) return { incoming: null, hosted, action: "none", reason: null };
  if (!Number.isInteger(incoming.byteSize) || incoming.byteSize < 0) {
    return { incoming, hosted, action: "reject", reason: "File size is invalid." };
  }
  if (incoming.byteSize > MAX_UPLOAD_BYTES) {
    return { incoming, hosted, action: "reject", reason: fileTooLargeMessage() };
  }
  if (typeof incoming.sha256 !== "string" || !isSha256Hex(incoming.sha256)) {
    return { incoming, hosted, action: "reject", reason: "File hash is invalid." };
  }
  if (!hosted) return { incoming, hosted, action: "upload", reason: null };
  if (overwrite) return { incoming, hosted, action: "replace", reason: "Existing file will be replaced after confirmation." };
  return { incoming, hosted, action: "skip", reason: "A file of this kind already exists. It was not replaced." };
}

async function hostedFilesFor(db: Database, projectId: string): Promise<{ pdf: HostedFileMeta | null; plan: HostedFileMeta | null }> {
  const rows = await db.select().from(files).where(eq(files.projectId, projectId));
  const byKind = new Map(rows.map((row) => [row.kind, { byteSize: row.byteSize, mime: row.mime }]));
  return {
    pdf: byKind.get("pdf") ?? null,
    plan: byKind.get("plan") ?? null,
  };
}

function totals(results: ImportItemResult[]): ImportReport["totals"] {
  return {
    incomingProjects: results.length,
    imported: results.filter((item) => item.action === "import").length,
    skipped: results.filter((item) => item.action === "skip").length,
    overwritten: results.filter((item) => item.action === "overwrite").length,
    failed: results.filter((item) => item.action === "fail").length,
    incomingStations: results.reduce((sum, item) => sum + item.stations.incoming, 0),
    hostedStations: results.reduce((sum, item) => sum + (item.stations.hosted ?? 0), 0),
    incomingFiles: results.reduce((sum, item) => sum + (item.files.pdf.incoming ? 1 : 0) + (item.files.plan.incoming ? 1 : 0), 0),
    hostedFiles: results.reduce((sum, item) => sum + (item.files.pdf.hosted ? 1 : 0) + (item.files.plan.hosted ? 1 : 0), 0),
    filesToUpload: results.reduce(
      (sum, item) => sum + (item.files.pdf.action === "upload" || item.files.pdf.action === "replace" ? 1 : 0) + (item.files.plan.action === "upload" || item.files.plan.action === "replace" ? 1 : 0),
      0,
    ),
    filesRejected: results.reduce(
      (sum, item) => sum + (item.files.pdf.action === "reject" ? 1 : 0) + (item.files.plan.action === "reject" ? 1 : 0),
      0,
    ),
  };
}

async function insertProject(db: Database, ownerId: string, project: EarthworkProject, gprc: GprcRecord) {
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
      documentStored: false,
      visibility: project.visibility,
      dockTab: project.dockTab,
      snap: project.snap === true,
      stations: project.stations,
    });
    await tx.insert(gprcRecords).values({ projectId: project.id, record: gprc });
  });
}

async function overwriteProject(db: Database, project: EarthworkProject, gprc: GprcRecord, row: typeof projects.$inferSelect) {
  const updatedAt = new Date(project.updatedAt);
  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({
        name: project.name,
        updatedAt,
        revision: row.revision + 1,
        activeStationId: project.activeStationId,
        pageNumber: project.pageNumber ?? 1,
        documentName: project.document?.name ?? null,
        visibility: project.visibility,
        dockTab: project.dockTab,
        snap: project.snap === true,
        stations: project.stations,
      })
      .where(eq(projects.id, project.id));
    await tx
      .insert(gprcRecords)
      .values({ projectId: project.id, record: gprc })
      .onConflictDoUpdate({ target: gprcRecords.projectId, set: { record: gprc } });
  });
}

export async function importProjectsForOwner(
  db: Database,
  ownerId: string,
  items: ImportItemInput[],
  options: ImportOptions,
): Promise<ImportReport> {
  const overwriteIds = new Set((options.overwriteIds ?? []).filter((id) => UUID_RE.test(id)));
  const results: ImportItemResult[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    let project: EarthworkProject;
    let gprc: GprcRecord;
    try {
      project = parseImportedProject(item.project);
      gprc = item.gprc === undefined ? emptyGprcRecord() : parseGprcBody(item.gprc);
    } catch (error) {
      const name = typeof (item.project as { name?: string } | null)?.name === "string" ? (item.project as { name: string }).name : "Invalid project";
      const id = typeof (item.project as { id?: string } | null)?.id === "string" ? (item.project as { id: string }).id : "unknown";
      results.push({
        id,
        name,
        action: "fail",
        reason: error instanceof BadProjectData ? error.message : "Project data is invalid.",
        stations: { incoming: 0, hosted: null },
        alignmentMarkerCount: 0,
        georefPointCount: 0,
        files: {
          pdf: emptyFilePlan(item.files?.pdf ?? null, null),
          plan: emptyFilePlan(item.files?.plan ?? null, null),
        },
      });
      continue;
    }

    if (seen.has(project.id)) {
      results.push({
        id: project.id,
        name: project.name,
        action: "fail",
        reason: "This project id appears more than once in the import.",
        stations: { incoming: stationCount(project), hosted: null },
        alignmentMarkerCount: alignmentMarkerCount(gprc),
        georefPointCount: georefPointCount(gprc),
        files: {
          pdf: emptyFilePlan(item.files?.pdf ?? null, null),
          plan: emptyFilePlan(item.files?.plan ?? null, null),
        },
      });
      continue;
    }
    seen.add(project.id);

    const rows = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1);
    const existing = rows[0] ?? null;
    const overwrite = overwriteIds.has(project.id);
    const incomingFiles = {
      pdf: item.files?.pdf ?? null,
      plan: item.files?.plan ?? null,
    };

    if (existing && existing.ownerId !== ownerId) {
      results.push({
        id: project.id,
        name: project.name,
        action: "fail",
        reason: "This project id is not available.",
        stations: { incoming: stationCount(project), hosted: null },
        alignmentMarkerCount: alignmentMarkerCount(gprc),
        georefPointCount: georefPointCount(gprc),
        files: {
          pdf: emptyFilePlan(incomingFiles.pdf, null),
          plan: emptyFilePlan(incomingFiles.plan, null),
        },
      });
      continue;
    }

    const hosted = existing ? await hostedFilesFor(db, project.id) : { pdf: null, plan: null };
    const filePlans = {
      pdf: planFile(incomingFiles.pdf, hosted.pdf, overwrite),
      plan: planFile(incomingFiles.plan, hosted.plan, overwrite),
    };

    if (!existing) {
      try {
        if (options.apply) await insertProject(db, ownerId, project, gprc);
      } catch {
        results.push({
          id: project.id,
          name: project.name,
          action: "fail",
          reason: "Could not insert this project.",
          stations: { incoming: stationCount(project), hosted: null },
          alignmentMarkerCount: alignmentMarkerCount(gprc),
          georefPointCount: georefPointCount(gprc),
          files: {
            pdf: emptyFilePlan(incomingFiles.pdf, hosted.pdf),
            plan: emptyFilePlan(incomingFiles.plan, hosted.plan),
          },
        });
        continue;
      }
      results.push({
        id: project.id,
        name: project.name,
        action: "import",
        reason: options.apply ? "Inserted with the original project id." : "Would insert with the original project id.",
        stations: { incoming: stationCount(project), hosted: options.apply ? stationCount(project) : 0 },
        alignmentMarkerCount: alignmentMarkerCount(gprc),
        georefPointCount: georefPointCount(gprc),
        files: filePlans,
      });
      continue;
    }

    if (!overwrite) {
      const hostedProject = {
        stations: existing.stations as EarthworkProject["stations"],
      };
      results.push({
        id: project.id,
        name: existing.name,
        action: "skip",
        reason: "A project with this id already exists. It was not changed. Missing files can still be uploaded.",
        stations: { incoming: stationCount(project), hosted: hostedProject.stations.length },
        alignmentMarkerCount: alignmentMarkerCount(gprc),
        georefPointCount: georefPointCount(gprc),
        files: filePlans,
      });
      continue;
    }

    try {
      if (options.apply) await overwriteProject(db, project, gprc, existing);
    } catch {
      results.push({
        id: project.id,
        name: project.name,
        action: "fail",
        reason: "Could not replace this project.",
        stations: { incoming: stationCount(project), hosted: Array.isArray(existing.stations) ? existing.stations.length : 0 },
        alignmentMarkerCount: alignmentMarkerCount(gprc),
        georefPointCount: georefPointCount(gprc),
        files: filePlans,
      });
      continue;
    }
    results.push({
      id: project.id,
      name: project.name,
      action: "overwrite",
      reason: options.apply ? "Replaced the existing project after confirmation." : "Would replace the existing project after confirmation.",
      stations: { incoming: stationCount(project), hosted: stationCount(project) },
      alignmentMarkerCount: alignmentMarkerCount(gprc),
      georefPointCount: georefPointCount(gprc),
      files: filePlans,
    });
  }

  return {
    dryRun: !options.apply,
    origin: options.origin ?? null,
    results,
    totals: totals(results),
  };
}
