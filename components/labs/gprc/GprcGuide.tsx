"use client";

import { Box, Compass, FolderOpen, Map, Pencil, Route, Ruler } from "lucide-react";
import { useEffect, useState } from "react";
import { clampGuidePosition, defaultGuideState, GUIDE_STORAGE_KEY, parseGuideState, type GuideUiState } from "@/lib/corridor/guide-state";
import type { GprcPane } from "@/lib/corridor/storage";
import { cn } from "@/lib/utils";

type GoTarget = "projects" | "sections" | "plan" | "georef" | "export";

type Step = {
  title: string;
  body: string;
  where: string;
  go?: { target: GoTarget; label: string };
};

const STEPS: Step[] = [
  {
    title: "Create or open a project",
    body: "Open the project list from the menu. Create a project, or open one you already have. Duplicate is useful when you want to try a trace or a georeference without changing the original. The copy keeps its own stations, PDF, plan, and control points.",
    where: "Menu at the top left",
    go: { target: "projects", label: "Open projects" },
  },
  {
    title: "Upload and calibrate cross-sections",
    body: "Switch to Cross-sections and load the cross-section PDF. Add a station by its name, such as 20+50. The page number is not the station number. Calibrate with three clicks on known grid intersections: the centerline at the lowest elevation, the same elevation at another offset, then a different elevation. Type each offset and elevation in the calibration fields. Calibration maps drawing pixels to feet of offset and elevation. Status shows Calibration ✓ when it locks. On the next station, Reuse drags a finished calibration onto this page. Confirm it only after it sits on the new grid.",
    where: "Cross-sections",
    go: { target: "sections", label: "Open cross-sections" },
  },
  {
    title: "Trace existing and proposed ground",
    body: "Select the station in the list so its own PDF page opens. Click Existing and trace the existing-ground line from left to right. Click Proposed and trace the proposed line. The first and last proposed clicks are the daylight ties. Snap rounds a click to the nearest foot. Undo removes the last point. Traces are saved with that station. If the banner says the station is marked on another page, use Go to page before tracing. Cut and fill areas appear on the toolbar once both profiles exist.",
    where: "Cross-sections",
    go: { target: "sections", label: "Open cross-sections" },
  },
  {
    title: "Upload the mainline plan",
    body: "Switch to Mainline plan and load the stitched plan. Scroll to zoom and drag to pan. Fit returns to the whole sheet. This image is the plan the mainline is traced on. It is separate from the cross-section PDF.",
    where: "Mainline plan",
    go: { target: "plan", label: "Open mainline plan" },
  },
  {
    title: "Trace the mainline and place stations",
    body: "Choose Trace and click along the roadway centerline. Undo drops the last point. Finish stores the line once it has at least two points. Then choose Station and click the line to place a marker. Type the same station name you used on the cross-section, such as 20+50. A matching name links the marker to that record and keeps its calibration and traces. Two markers set the scale. The Stations panel can also place a station that already falls between two markers.",
    where: "Mainline plan",
    go: { target: "plan", label: "Open mainline plan" },
  },
  {
    title: "Review the 3D corridor",
    body: "The 3D view on the right places each finished cross-section on the mainline. Orbit, pan, and zoom to inspect it. Existing is the sky-blue surface, proposed is amber, and cut and fill are the walls between them. Turn each one on or off in the view. A station with no finished profile leaves a gap. It is not bridged. Labels mark stations that are not ready.",
    where: "3D view",
  },
  {
    title: "Georeference and export",
    body: "On the mainline plan, open Georeference. NAD83 / Georgia West (ftUS) is the starting coordinate system. Confirm it against the plan, or pick another. Choose Control pts and click the plan, then type each point's easting and northing. The fit reports how well the points agree. It is not a survey. Open Export and choose the surfaces, section lines, and station labels. Export 3D Corridor (KMZ) downloads the file. In Google Earth Pro, uncheck older copies of the same name, then look from above and from the side. The red mainline should sit on the road. Heights are measured from the existing-ground centerline on the terrain, not stacked on top of it.",
    where: "Mainline plan",
    go: { target: "export", label: "Open export" },
  },
];

type Props = {
  pane: GprcPane;
  onOpenProjects: () => void;
  onShowSections: () => void;
  onShowPlan: () => void;
  onShowGeoref: () => void;
  onShowExport: () => void;
};

export function GprcGuide({ pane, onOpenProjects, onShowSections, onShowPlan, onShowGeoref, onShowExport }: Props) {
  const [state, setState] = useState<GuideUiState>(defaultGuideState);
  const [ready, setReady] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(GUIDE_STORAGE_KEY);
    const next = parseGuideState(saved, window.innerWidth, window.innerHeight);
    if (!saved && pane === "sections") next.step = 1;
    setState({ ...next, ...clampGuidePosition(next.x, next.y, window.innerWidth, window.innerHeight) });
    setReady(true);
    // Restore saved UI once after mount. pane is only used when there is no saved state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(GUIDE_STORAGE_KEY, JSON.stringify(state));
  }, [ready, state]);

  useEffect(() => {
    const onResize = () => {
      setState((current) => {
        const next = clampGuidePosition(current.x, current.y, window.innerWidth, window.innerHeight);
        return next.x === current.x && next.y === current.y ? current : { ...current, ...next };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const step = STEPS[state.step] ?? STEPS[0];
  const go = (target: GoTarget) => {
    if (target === "projects") onOpenProjects();
    else if (target === "sections") onShowSections();
    else if (target === "plan") onShowPlan();
    else if (target === "georef") onShowGeoref();
    else onShowExport();
  };
  const moveTo = (index: number) => setState((current) => ({ ...current, step: index, collapsed: false }));

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    setDrag({ dx: event.clientX - state.x, dy: event.clientY - state.y });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone should not block the drag.
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    const next = clampGuidePosition(event.clientX - drag.dx, event.clientY - drag.dy, window.innerWidth, window.innerHeight);
    setState((current) => ({ ...current, ...next }));
  };
  const onPointerUp = () => setDrag(null);

  if (!ready) return null;

  if (state.collapsed) {
    return (
      <button
        type="button"
        style={{ left: state.x, top: state.y }}
        onClick={() => setState({ ...state, collapsed: false })}
        className="fixed z-40 rounded-full border border-white/15 bg-[#101214] px-3 py-1.5 text-[12px] font-medium text-foreground shadow-lg hover:border-accent"
      >
        Guide
      </button>
    );
  }

  return (
    <aside
      style={{ left: state.x, top: state.y }}
      className="fixed z-40 flex max-h-[min(32rem,calc(100vh-1rem))] w-[min(20rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-white/10 bg-[#101214] text-[12px] text-foreground shadow-xl"
      data-gprc-guide=""
    >
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex cursor-grab items-center gap-2 border-b border-white/[0.06] px-2 py-1.5 active:cursor-grabbing"
      >
        <span className="font-medium tracking-tight">Guide</span>
        <span className="text-[11px] text-muted">
          {state.step + 1} / {STEPS.length}
        </span>
        <button type="button" className="ml-auto rounded px-1.5 py-0.5 text-muted hover:bg-white/10 hover:text-foreground" onClick={() => setState({ ...state, collapsed: true })}>
          Collapse
        </button>
      </header>
      <div className="h-1 bg-white/5">
        <div className="h-full bg-accent" style={{ width: `${((state.step + 1) / STEPS.length) * 100}%` }} />
      </div>
      <ol className="flex gap-1 overflow-x-auto border-b border-white/[0.06] px-2 py-1">
        {STEPS.map((item, index) => (
          <li key={item.title}>
            <button
              type="button"
              aria-current={index === state.step ? "step" : undefined}
              onClick={() => moveTo(index)}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-[11px]",
                index === state.step ? "bg-accent text-black" : "bg-white/10 text-muted hover:text-foreground",
              )}
              title={item.title}
            >
              {index + 1}
            </button>
          </li>
        ))}
      </ol>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
        <div className="flex items-start gap-2">
          <StepIcon index={state.step} />
          <h2 className="text-[13px] font-medium leading-snug">{step.title}</h2>
        </div>
        <p className="leading-relaxed text-muted">{step.body}</p>
        <p className="text-[11px] text-foreground/80">Where: {step.where}</p>
        {step.go && (
          <button type="button" onClick={() => go(step.go!.target)} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-black">
            {step.go.label}
          </button>
        )}
      </div>
      <footer className="flex items-center justify-between border-t border-white/[0.06] px-2 py-1.5">
        <button
          type="button"
          disabled={state.step === 0}
          onClick={() => moveTo(state.step - 1)}
          className="rounded px-2 py-1 text-muted hover:bg-white/10 hover:text-foreground disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={state.step === STEPS.length - 1}
          onClick={() => moveTo(state.step + 1)}
          className="rounded px-2 py-1 text-muted hover:bg-white/10 hover:text-foreground disabled:opacity-40"
        >
          Next
        </button>
      </footer>
    </aside>
  );
}

function StepIcon({ index }: { index: number }) {
  const className = "mt-0.5 h-4 w-4 shrink-0 text-accent";
  if (index === 0) return <FolderOpen className={className} />;
  if (index === 1) return <Ruler className={className} />;
  if (index === 2) return <Pencil className={className} />;
  if (index === 3) return <Map className={className} />;
  if (index === 4) return <Route className={className} />;
  if (index === 5) return <Box className={className} />;
  return <Compass className={className} />;
}
