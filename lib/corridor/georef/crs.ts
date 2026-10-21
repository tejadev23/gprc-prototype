import proj4 from "proj4";

/**
 * Coordinate reference systems GPRC can georeference into. The definitions are explicit and live here,
 * apart from the pixel-to-plan transform in `transform.ts`, so a CRS can be checked or added without
 * touching the fit.
 *
 * Horizontal only. Vertical datum is separate metadata (see `Georef.vertical`) and is never derived from
 * these definitions.
 */

export type CrsUnits = "ft-us" | "ft-intl" | "m";

export type CrsDef = {
  code: string;
  name: string;
  /** proj4 definition string. Units and false origin are part of it. */
  proj4: string;
  units: CrsUnits;
  /** Horizontal datum of the projected coordinates. */
  datum: "NAD83";
  /** Rough area of use, to catch a wrong zone or wrong units. Not a legal boundary. */
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
};

const GEORGIA_BOUNDS = { minLon: -85.8, maxLon: -80.7, minLat: 30.3, maxLat: 35.1 };

const GEORGIA_WEST = "+proj=tmerc +lat_0=30 +lon_0=-84.1666666666667 +k=0.9999 +x_0=700000 +y_0=0 +ellps=GRS80";
const GEORGIA_EAST = "+proj=tmerc +lat_0=30 +lon_0=-82.1666666666667 +k=0.9999 +x_0=200000 +y_0=0 +ellps=GRS80";

/** The first entry is the starting configuration for a new GPRC project. It is not treated as verified. */
export const CRS_OPTIONS: readonly CrsDef[] = [
  {
    code: "EPSG:2240",
    name: "NAD83 / Georgia West (ftUS)",
    proj4: `${GEORGIA_WEST} +units=us-ft +no_defs`,
    units: "ft-us",
    datum: "NAD83",
    bounds: GEORGIA_BOUNDS,
  },
  {
    code: "EPSG:2239",
    name: "NAD83 / Georgia East (ftUS)",
    proj4: `${GEORGIA_EAST} +units=us-ft +no_defs`,
    units: "ft-us",
    datum: "NAD83",
    bounds: GEORGIA_BOUNDS,
  },
  {
    code: "EPSG:26967",
    name: "NAD83 / Georgia West (m)",
    proj4: `${GEORGIA_WEST} +units=m +no_defs`,
    units: "m",
    datum: "NAD83",
    bounds: GEORGIA_BOUNDS,
  },
  {
    code: "EPSG:26966",
    name: "NAD83 / Georgia East (m)",
    proj4: `${GEORGIA_EAST} +units=m +no_defs`,
    units: "m",
    datum: "NAD83",
    bounds: GEORGIA_BOUNDS,
  },
];

export const DEFAULT_CRS_CODE = CRS_OPTIONS[0].code;

export function findCrs(code: string): CrsDef | null {
  return CRS_OPTIONS.find((crs) => crs.code === code) ?? null;
}

const METERS_PER_UNIT: Record<CrsUnits, number> = {
  "ft-us": 1200 / 3937,
  "ft-intl": 0.3048,
  m: 1,
};

/** Metres in one of this unit. */
export function unitToMeters(units: CrsUnits): number {
  return METERS_PER_UNIT[units];
}

export function unitToFeet(units: CrsUnits): number {
  return METERS_PER_UNIT[units] / 0.3048;
}

export function unitLabel(units: CrsUnits): string {
  return units === "ft-us" ? "ftUS" : units === "ft-intl" ? "ft" : "m";
}

export type LonLat = { lon: number; lat: number };

const converters = new Map<string, proj4.Converter>();

function converter(crs: CrsDef): proj4.Converter {
  let found = converters.get(crs.code);
  if (!found) {
    found = proj4(crs.proj4, "EPSG:4326");
    converters.set(crs.code, found);
  }
  return found;
}

/**
 * Projected easting/northing (in the CRS's own units) to WGS84 longitude/latitude, in degrees.
 * NAD83 and WGS84 are treated as the same datum here, a difference of about a metre in Georgia.
 */
export function projectedToWgs84(crs: CrsDef, easting: number, northing: number): LonLat {
  const [lon, lat] = converter(crs).forward([easting, northing]);
  return { lon, lat };
}

export function wgs84ToProjected(crs: CrsDef, lon: number, lat: number): { easting: number; northing: number } {
  const [easting, northing] = converter(crs).inverse([lon, lat]);
  return { easting, northing };
}

export function insideBounds(crs: CrsDef, point: LonLat): boolean {
  const { minLon, maxLon, minLat, maxLat } = crs.bounds;
  return point.lon >= minLon && point.lon <= maxLon && point.lat >= minLat && point.lat <= maxLat;
}

export function isValidLonLat(point: LonLat): boolean {
  return Number.isFinite(point.lon) && Number.isFinite(point.lat) && Math.abs(point.lon) <= 180 && Math.abs(point.lat) <= 90;
}
