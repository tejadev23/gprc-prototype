"use client";

import { computeAreas } from "@/lib/corridor/areas";
import type { Station } from "@/lib/corridor/types";
import { cn } from "@/lib/utils";

export function CutFillPanel({ stations, activeId }: { stations: Station[]; activeId: string | null }) {
  if (stations.length === 0) {
    return <p className="text-[12px] text-muted">Add a station and trace both profiles to calculate cut and fill.</p>;
  }

  return (
    <table className="w-full text-left text-[12px]">
      <thead className="text-[10px] uppercase tracking-[0.12em] text-muted">
        <tr>
          <th className="py-1 pr-3 font-medium">Station</th>
          <th className="px-3 py-1 text-right font-medium">Cut SF</th>
          <th className="px-3 py-1 text-right font-medium">Fill SF</th>
          <th className="px-3 py-1 text-right font-medium">Cut L / R</th>
          <th className="px-3 py-1 text-right font-medium">Fill L / R</th>
        </tr>
      </thead>
      <tbody>
        {stations.map((station) => {
          const areas = computeAreas(station);
          return (
            <tr key={station.id} className={cn(station.id === activeId && "text-accent")}>
              <td className="py-1 pr-3 font-mono">{station.name}</td>
              <td className="px-3 py-1 text-right font-mono text-cut">{areas ? areas.cut.toFixed(1) : "—"}</td>
              <td className="px-3 py-1 text-right font-mono text-fill">{areas ? areas.fill.toFixed(1) : "—"}</td>
              <td className="px-3 py-1 text-right font-mono text-muted">
                {areas ? `${areas.cutL.toFixed(1)} / ${areas.cutR.toFixed(1)}` : "—"}
              </td>
              <td className="px-3 py-1 text-right font-mono text-muted">
                {areas ? `${areas.fillL.toFixed(1)} / ${areas.fillR.toFixed(1)}` : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
