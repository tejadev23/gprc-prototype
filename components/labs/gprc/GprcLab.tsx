"use client";

import { Menu } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { BottomDock } from "@/components/labs/corridor/BottomDock";
import { CorridorViewport } from "@/components/labs/corridor/CorridorViewport";
import { ProjectDrawer } from "@/components/labs/corridor/ProjectDrawer";
import { saveLabel, useCorridorSession } from "@/components/labs/corridor/useCorridorSession";
import { GprcCrossSectionPane } from "@/components/labs/gprc/GprcCrossSectionPane";
import { MainlinePlanPanel } from "@/components/labs/gprc/MainlinePlanPanel";
import { GeoreferencePanel } from "@/components/labs/gprc/GeoreferencePanel";
import { GprcGuide } from "@/components/labs/gprc/GprcGuide";
import { KmzExportPanel } from "@/components/labs/gprc/KmzExportPanel";
import { StationReferencePanel } from "@/components/labs/gprc/StationReferencePanel";
import { chainageDistance, emptyAlignment, referenceScale, type AlignmentMarker, type PlanAlignment } from "@/lib/corridor/alignment";
import { normalizeKmzOptions, type KmzOptions } from "@/lib/corridor/kmz/options";
import { defaultGeoref, type ControlPoint, type Georef } from "@/lib/corridor/georef/model";
import { buildStationRows, relinkMarkers, type StationRow } from "@/lib/corridor/station-status";
import { createStation, isSectionReady, parseStation, stationsMatch } from "@/lib/corridor/stations";
import {
  defaultGprcView,
  emptyGprcRecord,
  getGprcRecord,
  getPlan,
  saveGprcRecord,
  savePlan,
  type GprcPane,
  type GprcRecord,
  type GprcView,
} from "@/lib/corridor/storage";
import { openPdfDocument, renderPdfPage } from "@/lib/labs/pdf-raster";
import { cn } from "@/lib/utils";

type PlanRaster = { url: string; width: number; height: number };

const sessionOptions = { startup: "manual", touchLast: false } as const;

export function GprcLab() {
  const session = useCorridorSession(sessionOptions);
  const { projectId } = session;
  const [pane, setPane] = useState<GprcPane>("plan");
  const [plan, setPlan] = useState<PlanRaster | null>(null);
  const [planName, setPlanName] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [storedAlignment, setAlignment] = useState<PlanAlignment>(emptyAlignment());
  const [view, setView] = useState<GprcView>(defaultGprcView());
  const [gprcReady, setGprcReady] = useState(false);
  const [storedGeoref, setStoredGeoref] = useState<Georef | null>(null);
  const [exportOptions, setExportOptions] = useState<KmzOptions>(() => normalizeKmzOptions(null));
  const [dock, setDock] = useState<"stations" | "georef" | "export" | null>("stations");
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [pickingControlId, setPickingControlId] = useState<string | null>(null);
  const [trackedProjectId, setTrackedProjectId] = useState<string | null>(projectId);
  const planUrl = useRef<string | null>(null);
  const recordRef = useRef<GprcRecord>(emptyGprcRecord());
  // Markers follow their station records by station value. Derived on every render, so a record that is
  // added, deleted or re-created never leaves a marker pointing at nothing.
  const alignment = useMemo(() => relinkMarkers(storedAlignment, session.stations), [storedAlignment, session.stations]);
  const stationRows = useMemo(() => buildStationRows(session.stations, alignment), [session.stations, alignment]);
  const placedIds = useMemo(() => new Set(stationRows.flatMap((row) => (row.onMainline && row.stationId ? [row.stationId] : []))), [stationRows]);

  if (projectId !== trackedProjectId) {
    setTrackedProjectId(projectId);
    setPlan(null);
    setPlanName(null);
    setPlanError(null);
    setAlignment(emptyAlignment());
    setView(defaultGprcView());
    setStoredGeoref(null);
    setExportOptions(normalizeKmzOptions(null));
    setSelectedControlId(null);
    setPickingControlId(null);
    setGprcReady(false);
    if (!projectId) setPane("plan");
  }

  useEffect(() => {
    const id = projectId;
    let cancelled = false;
    if (!id) {
      if (planUrl.current) URL.revokeObjectURL(planUrl.current);
      planUrl.current = null;
      recordRef.current = emptyGprcRecord();
      return;
    }
    (async () => {
      try {
        const record = (await getGprcRecord(id)) ?? emptyGprcRecord();
        if (cancelled) return;
        recordRef.current = record;
        setAlignment(record.alignment);
        setView(record.view);
        setStoredGeoref(record.georef);
        setExportOptions(record.export);
        setPane(record.pane);
        setPlanName(record.planFileName);
        setGprcReady(true);
        const blob = await getPlan(id);
        if (cancelled) return;
        if (!blob) {
          if (planUrl.current) URL.revokeObjectURL(planUrl.current);
          planUrl.current = null;
          setPlan(null);
          return;
        }
        const raster = await rasterizePlan(blob, record.planFileName ?? "plan", record.planMime ?? blob.type);
        if (cancelled) {
          URL.revokeObjectURL(raster.url);
          return;
        }
        if (planUrl.current) URL.revokeObjectURL(planUrl.current);
        planUrl.current = raster.url;
        setPlan({ url: raster.url, width: raster.width, height: raster.height });
        setPlanName(record.planFileName);
      } catch (err) {
        if (!cancelled) setPlanError(err instanceof Error ? err.message : "Could not open the stitched plan.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    return () => {
      if (planUrl.current) URL.revokeObjectURL(planUrl.current);
    };
  }, []);

  const persistRecord = (record: GprcRecord) => {
    const id = projectId;
    if (!id || !gprcReady) return;
    recordRef.current = record;
    void saveGprcRecord(id, record);
  };

  const saveAlignment = (next: PlanAlignment) => {
    setAlignment(next);
    persistRecord({ ...recordRef.current, alignment: next });
  };

  const georef = useMemo(() => storedGeoref ?? defaultGeoref(), [storedGeoref]);
  const saveGeoref = (next: Georef) => {
    setStoredGeoref(next);
    persistRecord({ ...recordRef.current, georef: next });
  };
  const saveExportOptions = (next: KmzOptions) => {
    setExportOptions(next);
    persistRecord({ ...recordRef.current, export: next });
  };
  // A control point must sit on the plan image itself.
  const onPlan = (px: number, py: number) => plan != null && px >= 0 && py >= 0 && px <= plan.width && py <= plan.height;
  const addControl = (px: number, py: number) => {
    if (!plan || !onPlan(px, py)) return;
    const id = crypto.randomUUID();
    const point: ControlPoint = { id, name: `CP${georef.points.length + 1}`, px, py, easting: null, northing: null };
    saveGeoref({ ...georef, points: [...georef.points, point], raster: georef.raster ?? { width: plan.width, height: plan.height } });
    setSelectedControlId(id);
    setDock("georef");
  };
  const moveControl = (id: string, px: number, py: number) => {
    if (!onPlan(px, py)) return;
    saveGeoref({ ...georef, points: georef.points.map((point) => (point.id === id ? { ...point, px, py } : point)) });
    setPickingControlId(null);
    setSelectedControlId(id);
  };
  const stationingFtPerPx = referenceScale(alignment.markers);
  const mainlineEnds =
    alignment.points.length >= 2 ? { start: alignment.points[0], end: alignment.points[alignment.points.length - 1] } : null;

  const saveView = (next: GprcView) => {
    setView(next);
    persistRecord({ ...recordRef.current, view: next });
  };

  const selectPane = (next: GprcPane) => {
    setPane(next);
    persistRecord({ ...recordRef.current, pane: next });
  };

  const commitMarker = (input: { id?: string; label: string; distancePx: number }) => {
    const stationFt = parseStation(input.label);
    if (!Number.isFinite(stationFt)) return "Enter a station such as 110+00.";
    const label = input.label.trim();
    if (alignment.markers.some((marker) => marker.id !== input.id && stationsMatch(marker.stationFt, stationFt))) {
      return "That station is already on the mainline.";
    }
    const current = input.id ? alignment.markers.find((marker) => marker.id === input.id) : undefined;
    let stationId = current?.stationId ?? null;
    const relink = !current || !stationsMatch(current.stationFt, stationFt) || !session.stations.some((station) => station.id === stationId);
    if (relink) {
      const matches = session.stations.filter((station) => stationsMatch(station.stationFt, stationFt));
      if (matches.length >= 1) {
        stationId = (matches.find((station) => station.id === session.activeId) ?? matches[0]).id;
      } else {
        const created = createStation(label);
        if (!created) return "Enter a station such as 110+00.";
        session.insertStation(created);
        stationId = created.id;
      }
    }
    const marker: AlignmentMarker = {
      id: input.id ?? crypto.randomUUID(),
      label,
      stationFt,
      distancePx: input.distancePx,
      stationId,
    };
    const markers = current
      ? alignment.markers.map((item) => (item.id === marker.id ? marker : item))
      : [...alignment.markers, marker];
    saveAlignment({ ...alignment, markers });
    return null;
  };

  const openMarker = (marker: AlignmentMarker) => {
    const linked = marker.stationId ? session.stations.find((station) => station.id === marker.stationId) : undefined;
    if (linked) {
      session.selectStation(linked.id);
      return;
    }
    const byFeet = session.stations.find((station) => stationsMatch(station.stationFt, marker.stationFt));
    if (byFeet) {
      saveAlignment({
        ...alignment,
        markers: alignment.markers.map((item) => (item.id === marker.id ? { ...item, stationId: byFeet.id } : item)),
      });
      session.selectStation(byFeet.id);
      return;
    }
    const created = createStation(marker.label);
    if (!created) return;
    session.insertStation(created);
    saveAlignment({
      ...alignment,
      markers: alignment.markers.map((item) => (item.id === marker.id ? { ...item, stationId: created.id } : item)),
    });
  };

  /**
   * Cross-section-first: a station can exist before any mainline. An existing record with the same station
   * value is selected, never duplicated. A marker already at that value is linked, so calibration and
   * traces on the record are kept as they are.
   */
  const addStationByName = (name: string): string | null => {
    const stationFt = parseStation(name);
    if (!Number.isFinite(stationFt)) return "Enter a station such as 10+50.";
    const existing = session.stations.find((station) => stationsMatch(station.stationFt, stationFt));
    if (existing) {
      session.selectStation(existing.id);
      return null;
    }
    const created = createStation(name);
    if (!created) return "Enter a station such as 10+50.";
    session.insertStation(created);
    const marker = alignment.markers.find((item) => stationsMatch(item.stationFt, stationFt));
    if (marker) {
      saveAlignment({ ...alignment, markers: alignment.markers.map((item) => (item.id === marker.id ? { ...item, stationId: created.id } : item)) });
    }
    return null;
  };

  /** Place an unmarked station on the mainline, only where its station value falls between two markers. */
  const placeStationRow = (row: StationRow): string | null => {
    const placed = chainageDistance(alignment.markers, row.stationFt);
    if ("error" in placed) return placed.error;
    return commitMarker({ label: row.name, distancePx: placed.distancePx });
  };

  const openStationRow = (row: StationRow) => {
    const marker = row.markerId ? alignment.markers.find((item) => item.id === row.markerId) : undefined;
    if (marker) openMarker(marker);
    else if (row.stationId) session.selectStation(row.stationId);
    selectPane("sections");
  };

  const onPlanFile = async (file: File) => {
    const id = session.projectId;
    if (!id) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/png");
      const blob = new Blob([await file.arrayBuffer()], { type: mime });
      await savePlan(id, blob);
      const nextAlignment = emptyAlignment();
      setAlignment(nextAlignment);
      // Control points belong to the old image. Keep the CRS and vertical settings, drop the points.
      setStoredGeoref((current) => (current ? { ...current, points: [], raster: null } : null));
      setSelectedControlId(null);
      setPickingControlId(null);
      const record = {
        ...recordRef.current,
        planFileName: file.name,
        planMime: mime,
        alignment: nextAlignment,
        georef: recordRef.current.georef ? { ...recordRef.current.georef, points: [], raster: null } : null,
      };
      recordRef.current = record;
      await saveGprcRecord(id, record);
      const raster = await rasterizePlan(blob, file.name, mime);
      if (planUrl.current) URL.revokeObjectURL(planUrl.current);
      planUrl.current = raster.url;
      setPlan({ url: raster.url, width: raster.width, height: raster.height });
      setPlanName(file.name);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Could not open that plan.");
    } finally {
      setPlanLoading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-3 py-1.5">
        <button
          type="button"
          onClick={() => session.setDrawerOpen(true)}
          className="rounded-md p-1.5 text-muted hover:bg-white/10 hover:text-foreground"
          aria-label="Open projects"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div className="text-[13px] font-medium tracking-tight">GPRC</div>
        <label className="ml-auto flex items-center gap-2 text-[12px] text-muted">
          Project
          <input
            value={session.projectName}
            onChange={(event) => session.setProjectName(event.target.value)}
            disabled={!session.projectId}
            className="w-40 rounded-md border border-white/10 bg-transparent px-2 py-1 text-foreground outline-none focus:border-accent disabled:opacity-40"
          />
        </label>
        <span className="text-[11px] text-muted">{session.projectId ? saveLabel(session.saveState) : "No project"}</span>
        <button
          type="button"
          className="rounded px-2 py-1 text-[12px] text-muted hover:bg-white/10 hover:text-foreground"
          onClick={() => {
            void fetch("/api/auth/logout", { method: "POST" }).then(() => {
              window.location.assign("/login");
            });
          }}
        >
          Sign out
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[minmax(0,1.86fr)_minmax(16rem,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        <section className="flex min-h-[420px] min-w-0 flex-col border-white/[0.06] lg:min-h-0">
          <div className="flex gap-1 border-b border-white/[0.06] px-2 py-1">
            <PaneButton active={pane === "plan"} onClick={() => selectPane("plan")}>
              Mainline plan
            </PaneButton>
            <PaneButton active={pane === "sections"} onClick={() => selectPane("sections")}>
              Cross-sections
            </PaneButton>
          </div>
          <div className={cn("min-h-0 flex-1 flex-col", pane === "plan" ? "flex" : "hidden")}>
            <MainlinePlanPanel
              hasProject={session.projectId != null}
              fileName={planName}
              raster={plan}
              loading={planLoading}
              error={planError}
              alignment={alignment}
              readyStationIds={session.stations.filter(isSectionReady).map((station) => station.id)}
              onLoadFile={(file) => void onPlanFile(file)}
              onAlignment={saveAlignment}
              onCommitMarker={commitMarker}
              onOpenSection={(marker) => {
                openMarker(marker);
                selectPane("sections");
              }}
              controlPoints={georef.points}
              selectedControlId={selectedControlId}
              pickingControlId={pickingControlId}
              onAddControl={addControl}
              onSelectControl={(id) => {
                setSelectedControlId(id);
                if (id) setDock("georef");
              }}
              onMoveControl={moveControl}
              onToolChange={(tool) => {
                if (tool === "control") setDock("georef");
                else setPickingControlId(null);
              }}
            />
            <StationReferencePanel
              open={dock === "stations"}
              onToggle={() => setDock((current) => (current === "stations" ? null : "stations"))}
              rows={stationRows}
              alignment={alignment}
              activeId={session.activeId}
              onSelect={(row) => row.stationId && session.selectStation(row.stationId)}
              onOpen={openStationRow}
              onPlace={placeStationRow}
            />
            <GeoreferencePanel
              open={dock === "georef"}
              onToggle={() => setDock((current) => (current === "georef" ? null : "georef"))}
              georef={georef}
              onChange={saveGeoref}
              raster={plan ? { width: plan.width, height: plan.height } : null}
              stationingFtPerPx={stationingFtPerPx}
              mainlineEnds={mainlineEnds}
              selectedId={selectedControlId}
              onSelect={setSelectedControlId}
              pickingId={pickingControlId}
              onPick={setPickingControlId}
            />
            <KmzExportPanel
              open={dock === "export"}
              onToggle={() => setDock((current) => (current === "export" ? null : "export"))}
              projectName={session.projectName}
              stations={session.stations}
              alignment={alignment}
              georef={georef}
              plan={plan}
              stationingFtPerPx={stationingFtPerPx}
              options={exportOptions}
              onOptions={saveExportOptions}
            />
          </div>
          <div className={cn("min-h-0 flex-1 flex-col", pane === "sections" ? "flex" : "hidden")}>
            <GprcCrossSectionPane
              session={session}
              alignment={alignment}
              onShowPlan={() => selectPane("plan")}
              onAddStation={addStationByName}
              placedIds={placedIds}
            />
          </div>
        </section>
        <div
          data-gprc-viewport=""
          className="h-full min-h-[320px] min-w-0 border-t border-white/[0.06] lg:min-h-0 lg:border-l lg:border-t-0"
        >
          <CorridorViewport
            stations={session.stations}
            alignment={alignment}
            activeStationId={session.activeId}
            showLabels={view.showLabels}
            labelScale={view.labelScale}
            surfaceOpacity={view.surfaceOpacity}
            onView={(patch) => saveView({ ...view, ...patch })}
            fullscreen={session.fullscreen}
            onFullscreen={session.setFullscreen}
            visibility={session.visibility}
            onVisibility={session.setVisibility}
          />
        </div>
      </div>
      <BottomDock
        tab={session.dockTab}
        onTab={session.setDockTab}
        stations={session.stations}
        activeId={session.activeId}
        exportSlot={{
          label: "Export KMZ",
          content: (
            <div className="flex items-center gap-3 text-[12px] text-muted">
              <span>The 3D corridor KMZ export lives under the plan, in the Export panel.</span>
              <button
                type="button"
                className="rounded-md border border-white/10 px-2 py-1 text-foreground hover:border-accent"
                onClick={() => {
                  selectPane("plan");
                  setDock("export");
                }}
              >
                Open export
              </button>
            </div>
          ),
        }}
      />
      <GprcGuide
        pane={pane}
        onOpenProjects={() => session.setDrawerOpen(true)}
        onShowSections={() => selectPane("sections")}
        onShowPlan={() => selectPane("plan")}
        onShowGeoref={() => {
          selectPane("plan");
          setDock("georef");
        }}
        onShowExport={() => {
          selectPane("plan");
          setDock("export");
        }}
      />
      <ProjectDrawer
        open={session.drawerOpen}
        projects={session.projects}
        activeId={session.projectId}
        onClose={() => session.setDrawerOpen(false)}
        onOpen={(id) => void session.openListedProject(id)}
        onCreate={(name) => void session.createListedProject(name)}
        onRename={(id, name) => void session.renameListedProject(id, name)}
        onDelete={(id) => void session.deleteListedProject(id)}
        onDuplicate={(id) => void session.duplicateListedProject(id)}
      />
    </div>
  );
}

function PaneButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("rounded px-2 py-1 text-[12px]", active ? "bg-accent text-black" : "text-muted hover:text-foreground")}
    >
      {children}
    </button>
  );
}

async function rasterizePlan(blob: Blob, name: string, mime: string): Promise<PlanRaster> {
  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    const doc = await openPdfDocument(await blob.arrayBuffer());
    const page = await renderPdfPage(doc, 1);
    return { url: page.objectUrl, width: page.width, height: page.height };
  }
  const url = URL.createObjectURL(blob);
  try {
    const size = await readImageSize(url);
    return { url, width: size.width, height: size.height };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not read that plan image."));
    img.src = url;
  });
}
