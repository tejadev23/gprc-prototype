import { computeAreas } from "./areas";
import type { Station } from "./types";

export type VolumeRow = {
  fromName: string;
  toName: string;
  lengthFt: number;
  cutCy: number | null;
  fillCy: number | null;
  note: string | null;
};

export type VolumeTable = {
  rows: VolumeRow[];
  cutCy: number;
  fillCy: number;
};

/** Average end area between stations ordered by station feet. Cubic yards = square feet × feet / 27. */
export function averageEndAreaVolumes(stations: readonly Station[]): VolumeTable {
  const ordered = [...stations].sort((a, b) => a.stationFt - b.stationFt || a.name.localeCompare(b.name));
  const rows: VolumeRow[] = [];
  let cutCy = 0;
  let fillCy = 0;

  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i];
    const to = ordered[i + 1];
    const lengthFt = to.stationFt - from.stationFt;
    const start = computeAreas(from);
    const end = computeAreas(to);
    if (!start || !end) {
      rows.push({
        fromName: from.name,
        toName: to.name,
        lengthFt,
        cutCy: null,
        fillCy: null,
        note: "Both stations need existing and proposed profiles.",
      });
      continue;
    }
    if (lengthFt <= 0) {
      rows.push({
        fromName: from.name,
        toName: to.name,
        lengthFt,
        cutCy: null,
        fillCy: null,
        note: "Station distance must be greater than zero.",
      });
      continue;
    }
    const cut = ((start.cut + end.cut) / 2) * lengthFt / 27;
    const fill = ((start.fill + end.fill) / 2) * lengthFt / 27;
    cutCy += cut;
    fillCy += fill;
    rows.push({ fromName: from.name, toName: to.name, lengthFt, cutCy: cut, fillCy: fill, note: null });
  }

  return { rows, cutCy, fillCy };
}
