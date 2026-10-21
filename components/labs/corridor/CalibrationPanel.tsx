"use client";

import { useEffect, useRef } from "react";
import type { CalibPoint, Station, TraceMode } from "@/lib/corridor/types";
import { cn } from "@/lib/utils";

const GUIDES = [
  "Point 1: click a grid intersection, usually centerline at the lowest elevation.",
  "Point 2: same elevation as point 1, different offset. This sets the horizontal scale.",
  "Point 3: a different elevation. This sets the vertical scale.",
];

type Props = {
  station: Station | null;
  mode: TraceMode;
  pickIdx: number | null;
  onChangePoint: (index: number, patch: Partial<CalibPoint>) => void;
  onRepick: (index: number) => void;
  onClearPoint: (index: number) => void;
  onReset: () => void;
};

export function CalibrationPanel({ station, mode, pickIdx, onChangePoint, onRepick, onClearPoint, onReset }: Props) {
  const offsetRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (mode !== "calibrate" || pickIdx == null) return;
    offsetRefs.current[pickIdx]?.focus();
  }, [mode, pickIdx, station?.id]);

  if (!station) {
    return <p className="px-3 py-2 text-[12px] text-muted">Select a station to calibrate its sheet.</p>;
  }

  return (
    <div className="px-2 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">Calibration</span>
        <span className={cn("text-[11px]", station.calibration.transform ? "text-fill" : "text-muted")}>
          {station.calibration.transform ? "Complete" : "Incomplete"}
        </span>
        <button type="button" onClick={onReset} className="ml-auto rounded bg-white/10 px-2 py-0.5 text-[11px]">
          Reset
        </button>
      </div>
      <div className="grid grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-x-1.5 gap-y-1">
        {station.calibration.points.map((point, index) => {
          const picking = mode === "calibrate" && pickIdx === index;
          return (
            <div key={index} className="contents">
              <span className={cn("font-mono text-[11px]", picking ? "text-accent" : "text-muted")}>{index + 1}</span>
              <input
                ref={(node) => {
                  offsetRefs.current[index] = node;
                }}
                type="number"
                step="0.01"
                value={point.offset ?? ""}
                placeholder="offset"
                aria-label={`Point ${index + 1} offset`}
                onChange={(event) => onChangePoint(index, { offset: readNumber(event.target.value) })}
                className="min-w-0 rounded border border-white/10 bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-accent"
              />
              <input
                type="number"
                step="0.01"
                value={point.elevation ?? ""}
                placeholder="elev"
                aria-label={`Point ${index + 1} elevation`}
                onChange={(event) => onChangePoint(index, { elevation: readNumber(event.target.value) })}
                className="min-w-0 rounded border border-white/10 bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => onRepick(index)}
                className={cn("rounded px-1.5 py-0.5 text-[11px]", picking ? "bg-accent text-black" : "bg-white/10")}
              >
                {picking ? "Picking" : "Pick"}
              </button>
              <button
                type="button"
                onClick={() => onClearPoint(index)}
                className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-muted"
                aria-label={`Clear calibration point ${index + 1}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-muted">
        {pickIdx != null ? GUIDES[pickIdx] : "Three points must span both offset and elevation."}
      </p>
    </div>
  );
}

function readNumber(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
