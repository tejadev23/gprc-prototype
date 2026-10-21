/** Semantic line type is user-provided metadata — not inferred by the tracer. */
export type LineType = "EXISTING_GROUND" | "PROPOSED_GRADE";

export type Vec2 = { x: number; y: number };

export type FailureFlag =
  | "AMBIGUOUS"
  | "WEAK_EVIDENCE"
  | "GRID_JUMP"
  | "GRID_CAPTURE"
  | "LINE_JUMP"
  | "SUDDEN_TURN"
  | "GAP"
  | "ENDPOINT_UNREACHABLE"
  | "UNSUPPORTED_TAIL"
  | "CHORD_FABRICATION"
  | "TARGET_IDENTITY_LOST"
  | "COMPETING_PROFILE";

export type TraceStatus = "ok" | "low_confidence" | "failed";

export type TraceStopReason =
  | "reached_end"
  | "max_steps"
  | "endpoint_unreachable"
  | "no_candidates"
  | "weak_evidence_abort"
  | "target_identity_lost";

/**
 * Baseline = original greedy walker + axis-alignment heuristic (BASELINE V1).
 * Grid-aware = same greedy walker, penalty from the detected repeated graph grid.
 * Intelligent = V3 multi-hypothesis search (kept for comparison).
 * Constrained = V4: grid-follow is path state (cross vs ride), END is a
 *               validity condition, visually unsupported arrivals are rejected.
 */
export type ExperimentMode = "baseline" | "grid-aware" | "intelligent" | "constrained";

/**
 * Central parameter object. Heuristic weights live here — never as
 * scattered magic numbers in the tracer.
 */
export type TracingConfig = {
  /** Which grid-penalty strategy scoring uses. Baseline is preserved as-is. */
  experimentMode: ExperimentMode;
  /** RDP tolerance in image px for the editable control path. */
  simplifyTolerance: number;
  /** Fraction of row/column ink coverage above which a line is treated as grid. */
  gridCoverageThreshold: number;
  visualWeight: number;
  directionWeight: number;
  distanceWeight: number;
  smoothnessWeight: number;
  endpointWeight: number;
  gridWeight: number;
  /** How strongly a candidate must resemble the stroke measured at START. */
  identityWeight: number;
  searchRadius: number;
  stepSize: number;
  /** Radians. Candidates outside this cone from expected heading are dropped. */
  maxDirectionChange: number;
  maxSteps: number;
  endRadius: number;
  snapRadius: number;
  /** If (best - secondBest) < this, flag AMBIGUOUS. */
  ambiguityMargin: number;
  /** Ridge/ink sample below this → WEAK_EVIDENCE. */
  weakEvidenceThreshold: number;
  gapBridgeEnabled: boolean;
  beamWidth: number;
  blurSigma: number;
  cannyLow: number;
  cannyHigh: number;
  /** Abort if this many consecutive steps move away from the endpoint. */
  awayFromEndLimit: number;

  // ---- Intelligent search (mode = "intelligent") ----
  /** Hard cap on node expansions (bounded search). */
  searchMaxExpansions: number;
  /** Weighted-A* factor on the endpoint heuristic (1 = admissible-ish, >1 = greedier). */
  searchHeuristicWeight: number;
  /** Prune a hypothesis once its arc length exceeds factor × straight-line distance. */
  searchMaxPathFactor: number;
  /** Success requires mean visual evidence along non-gap steps ≥ this (anti-fabrication). */
  searchMinMeanVisual: number;
  /** Success requires gap-bridged fraction of steps ≤ this (anti-fabrication). */
  searchMaxGapFraction: number;
  /** Consecutive on-mask axis-aligned steps after a capture before the branch dies. */
  maxGridFollowSteps: number;
  /** Mean visual of the last few steps required to accept an arrival at END. */
  searchTailVisual: number;
  /** Mean target-identity along a path required to call the arrival a success. */
  minMeanIdentity: number;
};

export type GridPenaltySource = "none" | "axis-heuristic" | "grid-mask";

/** Cached Grid Method C result in image pixels. */
export type GridPrior = {
  method: "C";
  nHorizontal: number;
  nVertical: number;
  spacingX: number | null;
  spacingY: number | null;
  coverage: number;
  confidence: number;
  meanLineLength: number;
  hLines: { y: number; x0: number; x1: number; score: number }[];
  vLines: { x: number; y0: number; y1: number; score: number }[];
  intersections: { x: number; y: number }[];
};

export type ScoreTerms = {
  visual: number;
  direction: number;
  distance: number;
  smoothness: number;
  endpoint: number;
  gridPenalty: number;
  /** Why gridPenalty is non-zero — inspectable in the debug table. */
  gridSource: GridPenaltySource;
  /** 1 = still the stroke measured at START. */
  targetIdentity: number;
  identityNote: "matches" | "gap" | "competing" | "neutral";
};

export type Candidate = {
  id: string;
  x: number;
  y: number;
  heading: Vec2;
  stepLength: number;
  gapBridge: boolean;
  terms: ScoreTerms;
  total: number;
  selected: boolean;
  rejectReason?: string;
};

export type TraceStep = {
  index: number;
  position: Vec2;
  expectedDirection: Vec2;
  searchRadius: number;
  stepSize: number;
  candidates: Candidate[];
  selected: Candidate | null;
  warnings: FailureFlag[];
  competingFeature?: string;
  /** Hypothesis this step belongs to (intelligent search only). */
  branchId?: string;
  /** Incremental cost of the selected step (intelligent search only; lower = better). */
  stepCost?: number;
  /** Accumulated path cost up to and including this step (intelligent search only). */
  totalCost?: number;
  /** Grid interaction of the selected step (constrained / search). */
  gridEvent?: "none" | "cross" | "ride" | "capture" | "along";
  /** Consecutive grid-ride steps on this hypothesis after a capture. */
  gridFollowSteps?: number;
};

export type BranchStatus = "success" | "dead_end" | "pruned" | "frontier";

/** Post-mortem of one search hypothesis — why competing paths lost. */
export type BranchSummary = {
  id: string;
  status: BranchStatus;
  /** Why the branch stopped (dead ends / pruning) or won. */
  reason: string;
  /** Feature that dominated this branch's cost: grid, weak evidence, curvature, gaps, none. */
  dominantFeature: "grid" | "weak_evidence" | "curvature" | "gaps" | "none";
  steps: number;
  cost: number;
  /** Closest the branch ever got to END, image px. */
  closestDistToEnd: number;
  lastPosition: Vec2;
  /** Partial polyline for overlay (subsampled; only kept for the top branches). */
  polyline?: Vec2[];
  /** Consecutive grid-ride steps when this branch died, if any. */
  gridFollowSteps?: number;
};

export type PathMetrics = {
  endpointError: number;
  pathLength: number;
  meanVisual: number;
  tailVisual: number;
  maxUnsupportedRun: number;
  /** Steps spent traveling along the grid after a capture (not crossings). */
  gridFollowLength: number;
  /** Number of contiguous ride runs (≈ capture events). */
  gridFollowSegments: number;
  gridCrossings: number;
  gridCaptureEvents: number;
  expansions: number;
  rejectedHypotheses: number;
  elapsedMs: number;
  /** Mean target-identity of selected steps. 1 when no signature could be measured. */
  meanIdentity?: number;
};

export type FailureReport = {
  reason: FailureFlag;
  cause: "GRID_CAPTURE" | "WEAK_EVIDENCE" | "ENDPOINT_UNREACHABLE" | "UNSUPPORTED_TAIL" | "CHORD_FABRICATION" | "MAX_STEPS" | "TARGET_IDENTITY_LOST";
  lastReliablePoint: Vec2;
  bestHypothesis: string;
  hypothesesExplored: number;
  detail: string;
};

export type TraceResult = {
  status: TraceStatus;
  stopReason: TraceStopReason;
  /** Raw trace — every step the walker took. Kept intact; not user-editable. */
  polyline: Vec2[];
  steps: TraceStep[];
  warnings: FailureFlag[];
  /** Which engine produced the result. */
  pathfinder: "beam" | "search";
  /** Hypothesis post-mortems (intelligent search only). */
  branches?: BranchSummary[];
  /** Search diagnostics (intelligent / constrained search). */
  searchStats?: { expansions: number; generated: number; deduped: number; prunedByLength: number };
  metrics?: PathMetrics;
  failure?: FailureReport;
  /** Grid-crossing locations on the accepted (or best partial) path, image px. */
  crossings?: Vec2[];
  start: Vec2;
  end: Vec2;
  direction: Vec2;
  lineType: LineType;
  config: TracingConfig;
  image: { width: number; height: number };
  fixtureId: string;
  /** Stroke measured at START. Absent on older results. */
  targetSignature?: {
    confident: boolean;
    inkOn: number;
    thickness: number;
    duty: number;
    gapPx: number;
  };
};

export type ViewState = {
  /** CSS pixels per image pixel. */
  scale: number;
  /** CSS position of image pixel (0, 0). */
  originX: number;
  originY: number;
};

export type Fixture = {
  id: string;
  label: string;
  src: string;
  notes: string;
};
