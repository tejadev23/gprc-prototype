export type KmzOptions = {
  existing: boolean;
  proposed: boolean;
  cut: boolean;
  fill: boolean;
  /** Profile lines at each finished station, inside the existing/proposed folders. */
  sectionLines: boolean;
  /** The traced mainline, draped on the ground (it carries no elevation). */
  mainline: boolean;
  /** The stitched plan image on the ground, as an optional backdrop. */
  planOverlay: boolean;
  /** A point and a label at each station that sits on the traced mainline. */
  stationLabels: boolean;
  /**
   * absolute: elevations as given, read by Google Earth as height above sea level. Nothing is converted.
   * clampToGround: ignore elevations and drape everything on the terrain (surfaces become flat footprints).
   */
  altitudeMode: "absolute" | "clampToGround";
};

export const defaultKmzOptions: KmzOptions = {
  existing: true,
  proposed: true,
  cut: false,
  fill: false,
  sectionLines: true,
  mainline: true,
  planOverlay: false,
  stationLabels: true,
  altitudeMode: "absolute",
};

/** Reads saved options, falling back per field so an older or damaged record still loads. */
export function normalizeKmzOptions(value: unknown): KmzOptions {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const flag = (key: keyof KmzOptions) => (typeof raw[key] === "boolean" ? (raw[key] as boolean) : (defaultKmzOptions[key] as boolean));
  return {
    existing: flag("existing"),
    proposed: flag("proposed"),
    cut: flag("cut"),
    fill: flag("fill"),
    sectionLines: flag("sectionLines"),
    mainline: flag("mainline"),
    planOverlay: flag("planOverlay"),
    stationLabels: flag("stationLabels"),
    altitudeMode: raw.altitudeMode === "clampToGround" ? "clampToGround" : "absolute",
  };
}
