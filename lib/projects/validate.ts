import { normalizeGeoref } from "@/lib/corridor/georef/model";
import { normalizeKmzOptions } from "@/lib/corridor/kmz/options";
import { emptyAlignment } from "@/lib/corridor/alignment";
import { normalizeGprcRecord, PROJECT_SCHEMA_VERSION, type EarthworkProject, type GprcRecord } from "@/lib/corridor/storage";
import type { Station } from "@/lib/corridor/types";

export class BadProjectData extends Error {}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function station(value: unknown): Station {
  if (!value || typeof value !== "object") throw new BadProjectData("A station is missing.");
  const raw = value as Partial<Station>;
  if (typeof raw.id !== "string" || !raw.id) throw new BadProjectData("A station is missing an id.");
  if (typeof raw.name !== "string") throw new BadProjectData("A station is missing a name.");
  if (!finite(raw.stationFt)) throw new BadProjectData(`Station ${raw.name} has no chainage.`);
  if (raw.pageNumber != null && (!Number.isInteger(raw.pageNumber) || raw.pageNumber < 1)) {
    throw new BadProjectData(`Station ${raw.name} has a bad page number.`);
  }
  const points = raw.calibration?.points;
  if (!points || points.length !== 3) throw new BadProjectData(`Station ${raw.name} has no calibration.`);
  for (const profile of [raw.existing, raw.proposed]) {
    if (!Array.isArray(profile)) throw new BadProjectData(`Station ${raw.name} is missing a profile.`);
    for (const point of profile) {
      if (!finite(point?.offset) || !finite(point?.elevation)) throw new BadProjectData(`Station ${raw.name} has a bad profile point.`);
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    stationFt: raw.stationFt,
    pageNumber: raw.pageNumber ?? null,
    calibration: { points, transform: raw.calibration?.transform ?? null },
    existing: raw.existing ?? [],
    proposed: raw.proposed ?? [],
    alignmentRef: { centerlineId: raw.alignmentRef?.centerlineId ?? null },
  };
}

const TABS = new Set(["volume", "cutfill", "alignment", "kms"]);

export function parseProjectBody(value: unknown, id: string): EarthworkProject {
  if (!value || typeof value !== "object") throw new BadProjectData("Project body is missing.");
  const raw = value as Partial<EarthworkProject>;
  if (!Array.isArray(raw.stations)) throw new BadProjectData("Stations are missing.");
  const visibility = raw.visibility;
  if (!visibility || typeof visibility !== "object") throw new BadProjectData("Visibility is missing.");
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Untitled Earthwork Project",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: PROJECT_SCHEMA_VERSION,
    stations: raw.stations.map(station),
    activeStationId: typeof raw.activeStationId === "string" ? raw.activeStationId : null,
    pageNumber: Number.isInteger(raw.pageNumber) && (raw.pageNumber as number) >= 1 ? (raw.pageNumber as number) : 1,
    document: {
      name: typeof raw.document?.name === "string" ? raw.document.name : null,
      stored: raw.document?.stored === true,
    },
    visibility: {
      existing: visibility.existing !== false,
      proposed: visibility.proposed !== false,
      cut: visibility.cut !== false,
      fill: visibility.fill !== false,
    },
    dockTab: TABS.has(raw.dockTab ?? "") ? raw.dockTab! : "volume",
    snap: raw.snap === true,
  };
}

export function parseGprcBody(value: unknown): GprcRecord {
  const record = normalizeGprcRecord(value as Partial<GprcRecord> | null);
  record.georef = normalizeGeoref(record.georef);
  record.export = normalizeKmzOptions(record.export);
  if (!record.alignment) record.alignment = emptyAlignment();
  return record;
}
