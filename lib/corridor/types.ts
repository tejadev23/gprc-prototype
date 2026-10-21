/** Engineering profile point. Offset and elevation are feet. */
export type ProfilePoint = {
  offset: number;
  elevation: number;
};

/** One of the three pixel-to-engineering calibration samples. */
export type CalibPoint = {
  px: number | null;
  py: number | null;
  offset: number | null;
  elevation: number | null;
};

/**
 * Axis-aligned pixel transform.
 * px = ox + offset * sx, py = oy + elevation * sy.
 * Pixel Y grows downward, so sy is typically negative.
 */
export type AxisTransform = {
  ox: number;
  oy: number;
  sx: number;
  sy: number;
};

export type Calibration = {
  points: [CalibPoint, CalibPoint, CalibPoint];
  transform: AxisTransform | null;
};

/** Reserved for a later centerline link. Not used by this prototype. */
export type AlignmentRef = {
  centerlineId: string | null;
};

export type Station = {
  id: string;
  name: string;
  /** Numeric station distance in feet, parsed from the station name. */
  stationFt: number;
  pageNumber: number | null;
  calibration: Calibration;
  existing: ProfilePoint[];
  proposed: ProfilePoint[];
  alignmentRef: AlignmentRef;
};

export type TraceMode = "calibrate" | "existing" | "proposed";

export type SectionAreas = {
  cut: number;
  fill: number;
  cutL: number;
  cutR: number;
  fillL: number;
  fillR: number;
};

export type CorridorVisibility = {
  existing: boolean;
  proposed: boolean;
  cut: boolean;
  fill: boolean;
};

export type DockTab = "volume" | "cutfill" | "alignment" | "kms";
