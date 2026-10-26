import { emptyAlignment, type PlanAlignment } from "./alignment";
import { normalizeGeoref, type Georef } from "./georef/model";
import { normalizeKmzOptions, type KmzOptions } from "./kmz/options";
import type { CorridorVisibility, DockTab, Station } from "./types";

/** Bump when the stored project shape changes. */
export const PROJECT_SCHEMA_VERSION = 1;

export type SaveState = "saved" | "saving" | "unsaved";

export type ProjectDocument = {
  name: string | null;
  /** True when the PDF bytes are stored beside the project. */
  stored: boolean;
};

export type EarthworkProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  stations: Station[];
  activeStationId: string | null;
  pageNumber: number;
  document: ProjectDocument;
  visibility: CorridorVisibility;
  dockTab: DockTab;
  snap: boolean;
};

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  stationCount: number;
  documentName: string | null;
};

export type LoadedProject = {
  project: EarthworkProject;
  pdf: Blob | null;
};

const DB_NAME = "earthwork-corridor";
const DB_VERSION = 2;
const LAST_PROJECT_KEY = "lastProjectId";
const LAST_GPRC_PROJECT_KEY = "lastGprcProjectId";

export type GprcPane = "plan" | "sections";

export type GprcView = {
  showLabels: boolean;
  /** Multiplier on the GPRC station-label size. The corridor lab does not use this. */
  labelScale: number;
  surfaceOpacity: number;
};

export function defaultGprcView(): GprcView {
  return { showLabels: true, labelScale: 0.45, surfaceOpacity: 0.32 };
}

/** Stitched-plan metadata. Bytes live in the plans store, not on the project record. */
export type GprcRecord = {
  planFileName: string | null;
  planMime: string | null;
  pane: GprcPane;
  alignment: PlanAlignment;
  view: GprcView;
  /** Control points and CRS. Absent until the user starts georeferencing. */
  georef: Georef | null;
  /** What the 3D corridor KMZ export includes. */
  export: KmzOptions;
  /**
   * Pixel space of the stitched plan. Null until a plan is opened.
   * `pdf-user` is PDF scale-1. `image` is a PNG/JPEG's natural pixels. `legacy-raster` is the old 3200px raster.
   */
  planSpace: "legacy-raster" | "pdf-user" | "image" | null;
};

export function emptyGprcRecord(): GprcRecord {
  return {
    planFileName: null,
    planMime: null,
    pane: "plan",
    alignment: emptyAlignment(),
    view: defaultGprcView(),
    georef: null,
    export: normalizeKmzOptions(null),
    planSpace: null,
  };
}

/** Older records have no alignment. Missing fields stay empty instead of being required. */
export function normalizeGprcRecord(raw: Partial<GprcRecord> | null | undefined): GprcRecord {
  const alignment = raw?.alignment;
  const view = raw?.view;
  const fallback = defaultGprcView();
  return {
    planFileName: raw?.planFileName ?? null,
    planMime: raw?.planMime ?? null,
    pane: raw?.pane === "sections" ? "sections" : "plan",
    alignment: {
      points: alignment?.points ?? [],
      draft: alignment?.draft ?? [],
      rasterWidth: alignment?.rasterWidth ?? null,
      rasterHeight: alignment?.rasterHeight ?? null,
      markers: alignment?.markers ?? [],
    },
    view: {
      showLabels: view?.showLabels !== false,
      labelScale: typeof view?.labelScale === "number" ? view.labelScale : fallback.labelScale,
      surfaceOpacity: typeof view?.surfaceOpacity === "number" ? view.surfaceOpacity : fallback.surfaceOpacity,
    },
    georef: normalizeGeoref(raw?.georef),
    export: normalizeKmzOptions(raw?.export),
    planSpace: raw?.planSpace === "pdf-user" || raw?.planSpace === "image" || raw?.planSpace === "legacy-raster" ? raw.planSpace : null,
  };
}

export type SaveProjectOptions = {
  /** When false, this save does not change which project the corridor lab opens next. */
  touchLast?: boolean;
};

export function emptyProject(name: string): EarthworkProject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name.trim() || "Untitled Earthwork Project",
    createdAt: now,
    updatedAt: now,
    version: PROJECT_SCHEMA_VERSION,
    stations: [],
    activeStationId: null,
    pageNumber: 1,
    document: { name: null, stored: false },
    visibility: { existing: true, proposed: true, cut: true, fill: true },
    dockTab: "volume",
    snap: false,
  };
}

export function toSummary(project: EarthworkProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    version: project.version,
    stationCount: project.stations.length,
    documentName: project.document.name,
  };
}


/** "Project A — Copy", then "Project A — Copy 2" when that name is taken. */
export function duplicateName(source: string, existing: string[]): string {
  const base = `${source.trim() || "Untitled Earthwork Project"} — Copy`;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function independentProjectCopy(source: EarthworkProject, name: string, now = new Date().toISOString()): EarthworkProject {
  const copy = structuredClone(source);
  copy.id = crypto.randomUUID();
  copy.name = name;
  copy.createdAt = now;
  copy.updatedAt = now;
  return copy;
}

export function formatUpdated(iso: string, now = Date.now()): string {
  const delta = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Updated yesterday";
  return `Updated ${days} days ago`;
}

const revisions = new Map<string, number>();
const projectCache = new Map<string, EarthworkProject>();
const gprcCache = new Map<string, GprcRecord>();
const queues = new Map<string, Promise<void>>();

function remember(project: EarthworkProject, gprc: GprcRecord | null, revision: number) {
  revisions.set(project.id, revision);
  projectCache.set(project.id, project);
  if (gprc) gprcCache.set(project.id, gprc);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  if (response.status === 401 && typeof window !== "undefined") window.location.assign("/login");
  return response;
}

function enqueue(id: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(id, next);
  return next;
}

async function push(id: string, touchLast: boolean) {
  const project = projectCache.get(id);
  if (!project) throw new Error("This project is not loaded.");
  const revision = revisions.get(id);
  if (revision == null) throw new Error("This project has no revision yet.");
  const response = await request(`/api/projects/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, gprc: gprcCache.get(id), revision, touchLast }),
  });
  if (response.status === 409) {
    const fresh = await getProject(id);
    if (!fresh) throw new Error("This project is no longer available.");
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("gprc-conflict", { detail: fresh }));
    return;
  }
  if (!response.ok) throw new Error("Could not save the project.");
  const body = (await response.json()) as { revision: number };
  revisions.set(id, body.revision);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const response = await request("/api/projects");
  if (!response.ok) throw new Error("Could not list projects.");
  const body = (await response.json()) as { projects: ProjectSummary[] };
  return body.projects;
}

export async function getLastProjectId(): Promise<string | null> {
  return getLastGprcProjectId();
}

export async function getLastGprcProjectId(): Promise<string | null> {
  const response = await request("/api/session/last-project");
  if (!response.ok) return null;
  const body = (await response.json()) as { id: string | null };
  return body.id;
}

export async function setLastGprcProjectId(id: string): Promise<void> {
  await request("/api/session/last-project", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function getProject(id: string): Promise<LoadedProject | null> {
  const response = await request(`/api/projects/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not open the project.");
  const body = (await response.json()) as { project: EarthworkProject; gprc: GprcRecord; revision: number };
  remember(body.project, normalizeGprcRecord(body.gprc), body.revision);
  const pdfResponse = await request(`/api/projects/${id}/file?kind=pdf`);
  const pdf = pdfResponse.status === 404 ? null : await pdfResponse.blob();
  return { project: body.project, pdf };
}

export async function createProject(name: string, options?: SaveProjectOptions): Promise<EarthworkProject> {
  const response = await request("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error("Could not create the project.");
  const body = (await response.json()) as { project: EarthworkProject; revision: number };
  remember(body.project, emptyGprcRecord(), body.revision);
  if (options?.touchLast === false) {
    // Creating a project records it as last opened. Callers that opt out still receive the new id.
  }
  return body.project;
}

export async function saveProject(project: EarthworkProject, pdf?: Blob | null, options?: SaveProjectOptions): Promise<void> {
  projectCache.set(project.id, project);
  await enqueue(project.id, async () => {
    await push(project.id, options?.touchLast !== false);
    if (pdf === undefined) return;
    if (pdf === null) {
      const response = await request(`/api/projects/${project.id}/file?kind=pdf`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("Could not remove the PDF.");
      return;
    }
    const form = new FormData();
    form.set("file", pdf, project.document.name ?? "sections.pdf");
    const response = await request(`/api/projects/${project.id}/file?kind=pdf`, { method: "PUT", body: form });
    if (!response.ok) throw new Error("Could not store the PDF.");
  });
}

export async function deleteProject(id: string): Promise<void> {
  const response = await request(`/api/projects/${id}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Could not delete the project.");
  revisions.delete(id);
  projectCache.delete(id);
  gprcCache.delete(id);
}

export async function getPlan(id: string): Promise<Blob | null> {
  const response = await request(`/api/projects/${id}/file?kind=plan`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not open the plan.");
  return response.blob();
}

export async function savePlan(id: string, blob: Blob): Promise<void> {
  const form = new FormData();
  form.set("file", blob, "plan");
  const response = await request(`/api/projects/${id}/file?kind=plan`, { method: "PUT", body: form });
  if (!response.ok) throw new Error("Could not store the plan.");
}

export async function getGprcRecord(id: string): Promise<GprcRecord | null> {
  return gprcCache.get(id) ?? null;
}

export async function saveGprcRecord(id: string, record: GprcRecord): Promise<void> {
  gprcCache.set(id, record);
  await enqueue(id, () => push(id, true));
}

export async function duplicateProject(id: string): Promise<EarthworkProject | null> {
  const response = await request(`/api/projects/${id}/duplicate`, { method: "POST" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not duplicate the project.");
  const body = (await response.json()) as { project: EarthworkProject; revision: number };
  remember(body.project, gprcCache.get(id) ?? emptyGprcRecord(), body.revision);
  return body.project;
}
