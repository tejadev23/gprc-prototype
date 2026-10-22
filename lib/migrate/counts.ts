import type { EarthworkProject, GprcRecord } from "@/lib/corridor/storage";

export function alignmentMarkerCount(gprc: GprcRecord | null | undefined): number {
  return gprc?.alignment?.markers?.length ?? 0;
}

export function georefPointCount(gprc: GprcRecord | null | undefined): number {
  return gprc?.georef?.points?.length ?? 0;
}

export function stationCount(project: EarthworkProject | null | undefined): number {
  return project?.stations?.length ?? 0;
}
