"use client";

import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Material, PerspectiveCamera, WebGLRenderer } from "three";
import { referenceScale, type PlanAlignment } from "@/lib/corridor/alignment";
import { buildAlignedCorridorGeometry } from "@/lib/corridor/alignment-geometry";
import { buildCorridorGeometry } from "@/lib/corridor/corridor-geometry";
import { nextNavMode } from "@/lib/corridor/nav";
import { isSectionReady } from "@/lib/corridor/stations";
import type { CorridorVisibility, Station } from "@/lib/corridor/types";
import { cn } from "@/lib/utils";

type Props = {
  stations: Station[];
  fullscreen: boolean;
  onFullscreen: (value: boolean) => void;
  visibility: CorridorVisibility;
  onVisibility: (next: CorridorVisibility) => void;
  /** When set, GPRC draws the traced mainline. The corridor lab leaves this unset. */
  alignment?: PlanAlignment | null;
  activeStationId?: string | null;
  /** Omit these to keep the corridor lab's label size and surface opacity. */
  showLabels?: boolean;
  labelScale?: number;
  surfaceOpacity?: number;
  onView?: (patch: { showLabels?: boolean; labelScale?: number; surfaceOpacity?: number }) => void;
};

type Rebuild = (stations: Station[], visibility: CorridorVisibility) => void;

export function CorridorViewport({
  stations,
  fullscreen,
  onFullscreen,
  visibility,
  onVisibility,
  alignment = null,
  activeStationId = null,
  showLabels = true,
  labelScale,
  surfaceOpacity,
  onView,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stationsRef = useRef(stations);
  const visibilityRef = useRef(visibility);
  const alignmentRef = useRef<PlanAlignment | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const viewRef = useRef({ showLabels: true, labelScale: undefined as number | undefined });
  /** Surface opacity is applied in place. Moving the slider must not rebuild lines or labels. */
  const opacityRef = useRef<number | undefined>(undefined);
  const surfacesRef = useRef<{ material: Material; fallback: number }[]>([]);
  const rebuildRef = useRef<Rebuild>(() => {});
  const actionsRef = useRef({
    fit: () => {},
    top: () => {},
    perspective: () => {},
    reset: () => {},
    setNav: (_mode: "orbit" | "roam") => {},
  });
  const [webglError, setWebglError] = useState(false);
  const [navMode, setNavMode] = useState<"orbit" | "roam">("orbit");
  const [showHint, setShowHint] = useState(false);
  const navModeRef = useRef(navMode);
  navModeRef.current = navMode;
  stationsRef.current = stations;
  visibilityRef.current = visibility;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
      if (disposed) return;

      let renderer: WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      } catch (err) {
        if (!disposed) setWebglError(true);
        console.error(err);
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b0c0e);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
      camera.position.set(120, 90, 120);

      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const key = new THREE.DirectionalLight(0xffffff, 0.85);
      key.position.set(40, 120, 80);
      scene.add(key);

      const grid = new THREE.GridHelper(800, 40, 0x2a3340, 0x1a2029);
      scene.add(grid);
      scene.add(new THREE.AxesHelper(30));

      const content = new THREE.Group();
      scene.add(content);

      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN,
      };
      controls.target.set(0, 0, 0);
      controls.update();

      const resize = () => {
        const width = wrap.clientWidth;
        const height = wrap.clientHeight;
        if (width < 2 || height < 2) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(wrap);

      let framed = false;
      let basis = "";

      const rebuild: Rebuild = (list, vis) => {
        clearGroup(content);
        surfacesRef.current = [];
        const aligned = alignmentRef.current;
        const nextBasis =
          aligned && aligned.points.length >= 2 ? (referenceScale(aligned.markers) != null ? "scaled" : "pixels") : "straight";
        if (nextBasis !== basis) {
          framed = false;
          basis = nextBasis;
        }
        const alignedGeometry = aligned && aligned.points.length >= 2 ? buildAlignedCorridorGeometry(list, aligned) : null;
        const geometry = alignedGeometry ?? buildCorridorGeometry(list);
        const centerline = alignedGeometry?.centerline ?? null;
        const existing = new THREE.Group();
        const proposed = new THREE.Group();
        const cut = new THREE.Group();
        const fill = new THREE.Group();
        const labels = new THREE.Group();
        existing.visible = vis.existing;
        proposed.visible = vis.proposed;
        cut.visible = vis.cut;
        fill.visible = vis.fill;

        for (const line of geometry.lines) {
          const parent = line.kind === "existing" ? existing : proposed;
          const buffer = new THREE.BufferGeometry();
          buffer.setAttribute("position", new THREE.BufferAttribute(line.positions, 3));
          const hot = alignedGeometry != null && activeIdRef.current != null && line.stationId === activeIdRef.current;
          const material =
            line.kind === "existing"
              ? new THREE.LineDashedMaterial({ color: hot ? 0xffffff : 0x7dd3fc, dashSize: 1.5, gapSize: 0.7 })
              : new THREE.LineBasicMaterial({ color: hot ? 0xfde68a : 0xfbbf24 });
          const object = new THREE.Line(buffer, material);
          if (line.kind === "existing") object.computeLineDistances();
          parent.add(object);
        }

        for (const ribbon of geometry.ribbons) {
          const parent = ribbon.kind === "existing" ? existing : proposed;
          const fallback = 0.32;
          const surface = meshOf(
            THREE,
            ribbon.positions,
            ribbon.indices,
            ribbon.kind === "existing" ? 0x7dd3fc : 0xfbbf24,
            opacityRef.current ?? fallback,
            ribbon.kind === "existing" ? RENDER_ORDER.existing : RENDER_ORDER.proposed,
            alignedGeometry != null,
            "surface",
          );
          surfacesRef.current.push({ material: surface.material, fallback });
          parent.add(surface.mesh);
        }
        for (const prism of geometry.prisms) {
          const parent = prism.kind === "cut" ? cut : fill;
          const fallback = 0.45;
          const surface = meshOf(
            THREE,
            prism.positions,
            prism.indices,
            prism.kind === "cut" ? 0xf87171 : 0x4ade80,
            opacityRef.current ?? fallback,
            prism.kind === "cut" ? RENDER_ORDER.cut : RENDER_ORDER.fill,
            alignedGeometry != null,
            "wall",
          );
          surfacesRef.current.push({ material: surface.material, fallback });
          parent.add(surface.mesh);
        }

        const labelSpan =
          viewRef.current.labelScale == null
            ? Math.max(14, geometry.span * 0.09)
            : Math.max(6, geometry.span * 0.09 * viewRef.current.labelScale);
        labels.visible = viewRef.current.showLabels;
        for (const label of geometry.labels) {
          const sprite = stationSprite(THREE, label.name, label.missing === true);
          sprite.position.set(label.position[0], label.position[1], label.position[2]);
          sprite.scale.set(labelSpan, labelSpan * 0.28, 1);
          if (alignedGeometry != null) sprite.renderOrder = RENDER_ORDER.labels;
          labels.add(sprite);
        }
        content.add(existing, proposed, cut, fill, labels);
        if (centerline && centerline.length >= 6) {
          const buffer = new THREE.BufferGeometry();
          buffer.setAttribute("position", new THREE.BufferAttribute(centerline, 3));
          content.add(new THREE.Line(buffer, new THREE.LineBasicMaterial({ color: 0x7f1d1d })));
        }

        if (!framed && (geometry.lines.length > 0 || (centerline != null && centerline.length >= 6))) {
          frameCamera(camera, controls, geometry.center, geometry.span);
          framed = true;
        }
        wrap.dataset.corridorLines = String(geometry.lines.length);
        wrap.dataset.corridorRibbons = String(geometry.ribbons.length);
        wrap.dataset.corridorPrisms = String(geometry.prisms.length);
        wrap.dataset.corridorCenterline = String(centerline ? centerline.length / 3 : 0);
        spanRef.current = geometry.span;
      };

      const spanRef = { current: 80 };
      const keys = new Set<string>();
      const look = { yaw: 0, pitch: 0, dx: 0, dy: 0 };
      const euler = new THREE.Euler(0, 0, 0, "YXZ");
      const forward = new THREE.Vector3();
      const right = new THREE.Vector3();
      const worldUp = new THREE.Vector3(0, 1, 0);
      const clock = new THREE.Clock();

      const syncLook = () => {
        euler.setFromQuaternion(camera.quaternion, "YXZ");
        look.yaw = euler.y;
        look.pitch = euler.x;
      };
      const enterRoam = () => {
        controls.enabled = false;
        syncLook();
      };
      const enterOrbit = () => {
        const direction = new THREE.Vector3();
        camera.getWorldDirection(direction);
        controls.target.copy(camera.position).addScaledVector(direction, Math.max(20, spanRef.current * 0.35));
        camera.up.set(0, 1, 0);
        controls.enabled = true;
        controls.update();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      };

      const frameCurrent = () => {
        const geometry = buildCorridorGeometry(stationsRef.current);
        camera.up.set(0, 1, 0);
        if (geometry.lines.length === 0) {
          controls.target.set(0, 0, 0);
          camera.position.set(120, 90, 120);
          controls.update();
          return;
        }
        frameCamera(camera, controls, geometry.center, geometry.span);
        if (navModeRef.current === "roam") syncLook();
      };

      const lookAround = (heightFactor: number, groundFactor: number) => {
        camera.up.set(0, 1, 0);
        const target = controls.target;
        const dist = Math.max(camera.position.distanceTo(target), 40);
        camera.position.set(
          target.x + dist * groundFactor,
          target.y + dist * heightFactor,
          target.z + dist * groundFactor,
        );
        controls.update();
      };

      actionsRef.current = {
        fit: frameCurrent,
        top: () => {
          const geometry = buildCorridorGeometry(stationsRef.current);
          const center = geometry.lines.length
            ? geometry.center
            : ([controls.target.x, controls.target.y, controls.target.z] as [number, number, number]);
          const dist = Math.max(camera.position.distanceTo(controls.target), geometry.span);
          camera.up.set(0, 1, 0);
          controls.target.set(center[0], center[1], center[2]);
          camera.position.set(center[0], center[1] + dist, center[2] + dist * 0.02);
          controls.update();
          if (navModeRef.current === "roam") syncLook();
        },
        perspective: () => {
          lookAround(0.55, 0.75);
          if (navModeRef.current === "roam") syncLook();
        },
        reset: () => {
          frameCurrent();
          if (navModeRef.current === "roam") syncLook();
        },
        setNav: (mode) => {
          if (mode === "roam") enterRoam();
          else enterOrbit();
        },
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (navModeRef.current !== "roam" || isTypingTarget(event.target)) return;
        if (!isRoamKey(event.key)) return;
        event.preventDefault();
        keys.add(event.key);
        if (event.shiftKey) keys.add("Shift");
      };
      const onKeyUp = (event: KeyboardEvent) => {
        keys.delete(event.key);
        if (event.key === "Shift") keys.delete("Shift");
      };
      const onMouseMove = (event: MouseEvent) => {
        if (document.pointerLockElement !== canvas) return;
        look.dx += event.movementX;
        look.dy += event.movementY;
      };
      const onCanvasClick = () => {
        if (navModeRef.current === "roam" && document.pointerLockElement !== canvas) {
          void canvas.requestPointerLock();
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("mousemove", onMouseMove);
      canvas.addEventListener("click", onCanvasClick);

      if (disposed) {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("click", onCanvasClick);
        observer.disconnect();
        controls.dispose();
        renderer.dispose();
        return;
      }

      rebuildRef.current = rebuild;
      rebuild(stationsRef.current, visibilityRef.current);

      let frame = 0;
      const tick = () => {
        const dt = Math.min(0.05, clock.getDelta());
        if (navModeRef.current === "roam") {
          if (look.dx !== 0 || look.dy !== 0) {
            look.yaw -= look.dx * 0.0022;
            look.pitch = Math.max(-1.35, Math.min(1.35, look.pitch - look.dy * 0.0022));
            look.dx = 0;
            look.dy = 0;
            euler.set(look.pitch, look.yaw, 0, "YXZ");
            camera.quaternion.setFromEuler(euler);
          }
          camera.getWorldDirection(forward);
          if (right.crossVectors(forward, worldUp).lengthSq() > 1e-6) right.normalize();
          let moveForward = 0;
          let moveStrafe = 0;
          let moveUp = 0;
          if (keys.has("ArrowUp") || keys.has("w") || keys.has("W")) moveForward += 1;
          if (keys.has("ArrowDown") || keys.has("s") || keys.has("S")) moveForward -= 1;
          if (keys.has("ArrowRight") || keys.has("d") || keys.has("D")) moveStrafe += 1;
          if (keys.has("ArrowLeft") || keys.has("a") || keys.has("A")) moveStrafe -= 1;
          if (keys.has("e") || keys.has("E") || keys.has(" ")) moveUp += 1;
          if (keys.has("q") || keys.has("Q")) moveUp -= 1;
          const speed = (keys.has("Shift") ? 3 : 1) * Math.max(25, spanRef.current * 0.45) * dt;
          if (moveForward) camera.position.addScaledVector(forward, moveForward * speed);
          if (moveStrafe) camera.position.addScaledVector(right, moveStrafe * speed);
          if (moveUp) camera.position.addScaledVector(worldUp, moveUp * speed);
        } else {
          controls.update();
        }
        wrap.dataset.nav = navModeRef.current;
        wrap.dataset.camera = camera.position.toArray().map((value) => value.toFixed(1)).join(",");
        renderer.render(scene, camera);
        frame = requestAnimationFrame(tick);
      };
      tick();

      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("mousemove", onMouseMove);
        canvas.removeEventListener("click", onCanvasClick);
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        controls.dispose();
        clearGroup(content);
        renderer.dispose();
        rebuildRef.current = () => {};
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  useEffect(() => {
    opacityRef.current = surfaceOpacity;
    for (const surface of surfacesRef.current) surface.material.opacity = surfaceOpacity ?? surface.fallback;
  }, [surfaceOpacity]);

  useEffect(() => {
    alignmentRef.current = alignment;
    activeIdRef.current = activeStationId;
    viewRef.current = { showLabels, labelScale };
    rebuildRef.current(stations, visibility);
  }, [stations, visibility, alignment, activeStationId, showLabels, labelScale]);

  useEffect(() => {
    if (navMode !== "roam") return;
    setShowHint(true);
    const timer = window.setTimeout(() => setShowHint(false), 4000);
    return () => window.clearTimeout(timer);
  }, [navMode]);

  const chooseNav = (requested: "orbit" | "roam") => {
    const next = nextNavMode(navMode, requested);
    if (next.mode === navMode && !next.frame) return;
    navModeRef.current = next.mode;
    setNavMode(next.mode);
    actionsRef.current.setNav(next.mode);
    if (next.frame) actionsRef.current.reset();
  };

  const ready = stations.filter(isSectionReady).length;

  return (
    <div
      ref={wrapRef}
      className={cn("relative h-full min-h-[320px] min-w-0 bg-[#0b0c0e]", fullscreen && "fixed inset-0 z-50")}
      data-nav={navMode}
    >
      <canvas ref={canvasRef} className="block h-full w-full touch-none" onContextMenu={(event) => event.preventDefault()} />
      <div
        className={cn(
          "absolute z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1",
          fullscreen ? "left-3 top-3 rounded-md border border-white/10 bg-[#0b0c0e]/95 p-1.5 shadow-lg" : "left-2 top-2",
        )}
      >
        <button
          type="button"
          onClick={() => onFullscreen(!fullscreen)}
          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-black"
        >
          {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          {fullscreen ? "Exit" : "Expand"}
        </button>
        <button type="button" title="Fit corridor" onClick={() => actionsRef.current.fit()} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          Fit
        </button>
        <button type="button" onClick={() => actionsRef.current.top()} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          Top
        </button>
        <button type="button" onClick={() => actionsRef.current.perspective()} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          Perspective
        </button>
        <button type="button" onClick={() => actionsRef.current.reset()} className="rounded bg-white/10 px-2 py-1 text-[11px]">
          Reset
        </button>
        <button
          type="button"
          onClick={() => chooseNav("orbit")}
          className={cn("rounded px-2 py-1 text-[11px]", navMode === "orbit" ? "bg-white/15 text-foreground" : "bg-white/5 text-muted")}
        >
          Orbit
        </button>
        <button
          type="button"
          aria-pressed={navMode === "roam"}
          onClick={() => chooseNav("roam")}
          className={cn("rounded px-2 py-1 text-[11px]", navMode === "roam" ? "bg-accent text-black" : "bg-white/10")}
        >
          {navMode === "roam" ? "Free Roam ✓" : "Free Roam"}
        </button>
        <VisButton on={visibility.existing} label="Existing" onClick={() => onVisibility({ ...visibility, existing: !visibility.existing })} />
        <VisButton on={visibility.proposed} label="Proposed" onClick={() => onVisibility({ ...visibility, proposed: !visibility.proposed })} />
        <VisButton on={visibility.cut} label="Cut" onClick={() => onVisibility({ ...visibility, cut: !visibility.cut })} />
        <VisButton on={visibility.fill} label="Fill" onClick={() => onVisibility({ ...visibility, fill: !visibility.fill })} />
        {onView && (
          <>
            <VisButton on={showLabels} label="Labels" onClick={() => onView({ showLabels: !showLabels })} />
            <label className="flex items-center gap-1 text-[11px] text-muted">
              Size
              <input
                type="range"
                min={0.25}
                max={1.25}
                step={0.05}
                value={labelScale ?? 0.45}
                aria-label="Station label size"
                onChange={(event) => onView({ labelScale: Number(event.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-muted">
              Opacity
              <input
                type="range"
                min={0.08}
                max={1}
                step={0.04}
                value={surfaceOpacity ?? 0.32}
                aria-label="Cross-section surface opacity"
                onChange={(event) => onView({ surfaceOpacity: Number(event.target.value) })}
              />
            </label>
          </>
        )}
      </div>
      {webglError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-muted">
          This browser could not create a 3D view.
        </div>
      )}
      {showHint && navMode === "roam" && (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-white/10 bg-[#0b0c0e]/90 px-3 py-2 text-[11px] leading-snug text-muted">
          <div className="font-medium text-foreground">Free roam</div>
          Arrow keys / WASD — move
          <br />
          Mouse — look
          <br />
          Shift — fast · Q / E — down / up
        </div>
      )}
      {ready === 0 && !webglError && !(alignment && alignment.points.length >= 2) && (
        <div className="pointer-events-none absolute inset-x-8 bottom-3 text-center text-[11px] text-muted">
          Trace existing and proposed profiles to build the corridor.
        </div>
      )}
    </div>
  );
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function isRoamKey(key: string) {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "w" ||
    key === "W" ||
    key === "a" ||
    key === "A" ||
    key === "s" ||
    key === "S" ||
    key === "d" ||
    key === "D" ||
    key === "q" ||
    key === "Q" ||
    key === "e" ||
    key === "E" ||
    key === " "
  );
}

function VisButton({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("rounded px-2 py-1 text-[11px]", on ? "bg-white/15 text-foreground" : "bg-white/5 text-muted")}>
      {label}
    </button>
  );
}

function frameCamera(camera: PerspectiveCamera, controls: OrbitControls, center: [number, number, number], span: number) {
  controls.target.set(center[0], center[1], center[2]);
  camera.up.set(0, 1, 0);
  camera.position.set(center[0] + span * 0.95, center[1] + span * 0.7, center[2] + span * 0.95);
  camera.lookAt(center[0], center[1], center[2]);
  controls.update();
}

function meshOf(
  THREE: typeof import("three"),
  positions: Float32Array,
  indices: Uint32Array,
  color: number,
  opacity: number,
  renderOrder: number,
  stable: boolean,
  role: "surface" | "wall",
) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // GPRC surfaces are unlit, so a surface keeps one color whatever the camera angle or the light,
  // and offset, so they do not fight the section lines on their edges. Walls write depth and sit
  // slightly off the ribbons, which already own the existing and proposed faces. The straight
  // corridor lab keeps its original lit material.
  let material: Material;
  if (stable) {
    material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: role === "wall",
      polygonOffset: true,
      polygonOffsetFactor: role === "wall" ? 2 : 1,
      polygonOffsetUnits: role === "wall" ? 4 : 1,
    });
  } else {
    geometry.computeVertexNormals();
    material = new THREE.MeshPhongMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
  }
  const mesh = new THREE.Mesh(geometry, material);
  if (stable) mesh.renderOrder = renderOrder;
  return { mesh, material };
}

/** Transparent objects draw in this fixed order, not by camera distance, so overlaps never swap. */
const RENDER_ORDER = { existing: 1, proposed: 2, cut: 3, fill: 3, labels: 10 } as const;

function stationSprite(THREE: typeof import("three"), name: string, missing = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 40;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = missing ? "rgba(11,12,14,0.55)" : "rgba(11,12,14,0.82)";
    ctx.fillRect(0, 0, 160, 40);
    if (missing) {
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, 158, 38);
    }
    ctx.fillStyle = missing ? "#94a3b8" : "#7dd3fc";
    ctx.font = "bold 16px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 80, 20);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  return new THREE.Sprite(material);
}

function clearGroup(group: import("three").Group) {
  group.traverse((object) => {
    if (object === group) return;
    const item = object as import("three").Object3D & {
      geometry?: import("three").BufferGeometry;
      material?: import("three").Material | import("three").Material[];
    };
    item.geometry?.dispose();
    if (Array.isArray(item.material)) item.material.forEach(disposeMaterial);
    else if (item.material) disposeMaterial(item.material);
  });
  group.clear();
}

function disposeMaterial(material: import("three").Material) {
  const mapped = material as import("three").Material & { map?: import("three").Texture | null };
  mapped.map?.dispose();
  material.dispose();
}
