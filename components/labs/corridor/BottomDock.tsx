"use client";

import type { ReactNode } from "react";
import { AlignmentPlaceholder } from "@/components/labs/corridor/AlignmentPlaceholder";
import { CutFillPanel } from "@/components/labs/corridor/CutFillPanel";
import { KmsPlaceholder } from "@/components/labs/corridor/KmsPlaceholder";
import { VolumeTable } from "@/components/labs/corridor/VolumeTable";
import type { DockTab, Station } from "@/lib/corridor/types";
import { cn } from "@/lib/utils";

const TABS: { id: DockTab; label: string }[] = [
  { id: "volume", label: "Volume" },
  { id: "cutfill", label: "Cut / Fill" },
  { id: "alignment", label: "Alignment" },
  { id: "kms", label: "Export KMS" },
];

type Props = {
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  stations: Station[];
  activeId: string | null;
  /** Replaces the export placeholder, for labs that can really export. */
  exportSlot?: { label: string; content: ReactNode };
};

export function BottomDock({ tab, onTab, stations, activeId, exportSlot }: Props) {
  return (
    <section className="flex h-32 shrink-0 flex-col border-t border-white/[0.06] bg-[#101214]">
      <div className="flex gap-1 border-b border-white/[0.06] px-3 py-1">
        {TABS.map((base) => {
          const item = base.id === "kms" && exportSlot ? { ...base, label: exportSlot.label } : base;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTab(item.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px]",
                tab === item.id ? "bg-accent text-black" : "text-muted hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {tab === "volume" && <VolumeTable stations={stations} />}
        {tab === "cutfill" && <CutFillPanel stations={stations} activeId={activeId} />}
        {tab === "alignment" && <AlignmentPlaceholder stations={stations} />}
        {tab === "kms" && (exportSlot ? exportSlot.content : <KmsPlaceholder />)}
      </div>
    </section>
  );
}
