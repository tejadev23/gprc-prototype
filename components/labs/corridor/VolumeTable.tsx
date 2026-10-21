"use client";

import type { Station } from "@/lib/corridor/types";
import { averageEndAreaVolumes } from "@/lib/corridor/volumes";

export function VolumeTable({ stations }: { stations: Station[] }) {
  if (stations.length < 2) {
    return <p className="text-[12px] text-muted">Add at least two stations to compute station-to-station volume.</p>;
  }

  const table = averageEndAreaVolumes(stations);

  return (
    <table className="w-full text-left text-[12px]">
      <thead className="text-[10px] uppercase tracking-[0.12em] text-muted">
        <tr>
          <th className="py-1 pr-3 font-medium">From → To</th>
          <th className="px-3 py-1 text-right font-medium">L (ft)</th>
          <th className="px-3 py-1 text-right font-medium">Cut CY</th>
          <th className="px-3 py-1 text-right font-medium">Fill CY</th>
          <th className="px-3 py-1 font-medium">Note</th>
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={`${index}-${row.fromName}-${row.toName}`}>
            <td className="py-1 pr-3 font-mono">
              {row.fromName} → {row.toName}
            </td>
            <td className="px-3 py-1 text-right font-mono">{row.lengthFt.toFixed(1)}</td>
            <td className="px-3 py-1 text-right font-mono text-cut">{row.cutCy == null ? "—" : row.cutCy.toFixed(1)}</td>
            <td className="px-3 py-1 text-right font-mono text-fill">{row.fillCy == null ? "—" : row.fillCy.toFixed(1)}</td>
            <td className="px-3 py-1 text-muted">{row.note ?? "Average end area"}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-white/[0.06]">
          <td className="py-1 pr-3">Total</td>
          <td />
          <td className="px-3 py-1 text-right font-mono text-cut">{table.cutCy.toFixed(1)}</td>
          <td className="px-3 py-1 text-right font-mono text-fill">{table.fillCy.toFixed(1)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}
