import { normalizeGprcRecord, type EarthworkProject, type GprcRecord } from "@/lib/corridor/storage";
import { sha256Hex } from "./hash";
import { alignmentMarkerCount, georefPointCount } from "./counts";
import { EARTHWORK_IDB_NAME } from "./types";
import { packMigrationZip, type PackedMigrationProject } from "./zip";

export type LocalProjectListing = {
  origin: string;
  database: string;
  found: boolean;
  stores: string[];
  projects: Array<{
    id: string;
    name: string;
    updatedAt: string;
    stationCount: number;
    alignmentMarkerCount: number;
    georefPointCount: number;
    hasPdf: boolean;
    hasPlan: boolean;
    pdfBytes: number | null;
    planBytes: number | null;
    pdfName: string | null;
    planName: string | null;
  }>;
};

function openReadonly(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this browser."));
      return;
    }
    const request = indexedDB.open(EARTHWORK_IDB_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

async function existingDatabase(): Promise<{ name: string; version: number } | null> {
  if (typeof indexedDB.databases !== "function") return null;
  const listed = await indexedDB.databases();
  const found = listed.find((item) => item.name === EARTHWORK_IDB_NAME);
  if (!found?.name) return null;
  return { name: found.name, version: found.version ?? 0 };
}

function readStore(db: IDBDatabase, name: string): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  if (!db.objectStoreNames.contains(name)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const store = tx.objectStore(name);
    const request = store.openCursor();
    const entries: Array<{ key: IDBValidKey; value: unknown }> = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      entries.push({ key: cursor.key, value: cursor.value });
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error(`Could not read ${name}.`));
  });
}

function blobSize(value: unknown): number | null {
  if (value instanceof Blob) return value.size;
  return null;
}

async function blobBytes(value: unknown, kind: "pdf" | "plan"): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!(value instanceof Blob) || value.size === 0) return null;
  const buffer = await value.arrayBuffer();
  const fallback = kind === "pdf" ? "application/pdf" : "image/png";
  return { bytes: new Uint8Array(buffer), mime: value.type || fallback };
}

export async function listLocalIdbProjects(): Promise<LocalProjectListing> {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const listed = await existingDatabase();
  if (typeof indexedDB.databases === "function" && !listed) {
    return { origin, database: EARTHWORK_IDB_NAME, found: false, stores: [], projects: [] };
  }
  const db = await openReadonly();
  if (!db) return { origin, database: EARTHWORK_IDB_NAME, found: false, stores: [], projects: [] };
  try {
    const [projectRows, gprcRows, pdfRows, planRows] = await Promise.all([
      readStore(db, "projects"),
      readStore(db, "gprc"),
      readStore(db, "pdfs"),
      readStore(db, "plans"),
    ]);
    const gprcById = new Map(gprcRows.map((row) => [String(row.key), normalizeGprcRecord(row.value as Partial<GprcRecord>)]));
    const pdfById = new Map(pdfRows.map((row) => [String(row.key), row.value]));
    const planById = new Map(planRows.map((row) => [String(row.key), row.value]));
    const projects = projectRows.map((row) => {
      const project = row.value as EarthworkProject;
      const id = typeof project?.id === "string" ? project.id : String(row.key);
      const gprc = gprcById.get(id);
      const pdf = pdfById.get(id);
      const plan = planById.get(id);
      return {
        id,
        name: typeof project?.name === "string" ? project.name : "Untitled Earthwork Project",
        updatedAt: typeof project?.updatedAt === "string" ? project.updatedAt : "",
        stationCount: Array.isArray(project?.stations) ? project.stations.length : 0,
        alignmentMarkerCount: alignmentMarkerCount(gprc),
        georefPointCount: georefPointCount(gprc),
        hasPdf: pdf instanceof Blob && pdf.size > 0,
        hasPlan: plan instanceof Blob && plan.size > 0,
        pdfBytes: blobSize(pdf),
        planBytes: blobSize(plan),
        pdfName: project?.document?.name ?? null,
        planName: gprc?.planFileName ?? null,
      };
    });
    return {
      origin,
      database: EARTHWORK_IDB_NAME,
      found: true,
      stores: [...db.objectStoreNames],
      projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  } finally {
    db.close();
  }
}

export async function exportLocalIdbProjects(ids: string[]): Promise<{ zip: Uint8Array; origin: string; count: number }> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) throw new Error("Select at least one project to export.");
  const origin = window.location.origin;
  const listed = await existingDatabase();
  if (typeof indexedDB.databases === "function" && !listed) {
    throw new Error(
      `No ${EARTHWORK_IDB_NAME} database on ${origin}. Open this page in the same browser profile and origin that currently shows the local projects.`,
    );
  }
  const db = await openReadonly();
  if (!db) throw new Error(`Could not open ${EARTHWORK_IDB_NAME} on ${origin}.`);
  try {
    const [projectRows, gprcRows, pdfRows, planRows] = await Promise.all([
      readStore(db, "projects"),
      readStore(db, "gprc"),
      readStore(db, "pdfs"),
      readStore(db, "plans"),
    ]);
    const projectsById = new Map(projectRows.map((row) => [String((row.value as EarthworkProject)?.id ?? row.key), row.value as EarthworkProject]));
    const gprcById = new Map(gprcRows.map((row) => [String(row.key), normalizeGprcRecord(row.value as Partial<GprcRecord>)]));
    const pdfById = new Map(pdfRows.map((row) => [String(row.key), row.value]));
    const planById = new Map(planRows.map((row) => [String(row.key), row.value]));
    const packed: PackedMigrationProject[] = [];
    for (const id of uniqueIds) {
      const project = projectsById.get(id);
      if (!project) throw new Error(`Project ${id} was not found in IndexedDB.`);
      const gprc = gprcById.get(id) ?? normalizeGprcRecord(null);
      const pdf = await blobBytes(pdfById.get(id), "pdf");
      const plan = await blobBytes(planById.get(id), "plan");
      packed.push({
        meta: {
          id: project.id,
          name: project.name,
          stationCount: project.stations?.length ?? 0,
          alignmentMarkerCount: alignmentMarkerCount(gprc),
          georefPointCount: georefPointCount(gprc),
          files: {
            pdf: pdf
              ? {
                  path: `files/${project.id}/pdf`,
                  byteSize: pdf.bytes.byteLength,
                  sha256: await sha256Hex(pdf.bytes),
                  mime: pdf.mime,
                }
              : null,
            plan: plan
              ? {
                  path: `files/${project.id}/plan`,
                  byteSize: plan.bytes.byteLength,
                  sha256: await sha256Hex(plan.bytes),
                  mime: plan.mime,
                }
              : null,
          },
        },
        payload: { project, gprc },
        files: { pdf: pdf?.bytes ?? null, plan: plan?.bytes ?? null },
      });
    }
    return { zip: packMigrationZip(packed, origin), origin, count: packed.length };
  } finally {
    db.close();
  }
}
