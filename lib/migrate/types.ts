import type { EarthworkProject, GprcRecord } from "@/lib/corridor/storage";

export const MIGRATION_FORMAT = "gprc-migration";
export const MIGRATION_FORMAT_VERSION = 1;
export const EARTHWORK_IDB_NAME = "earthwork-corridor";

export type MigrationFileKind = "pdf" | "plan";

export type MigrationFileMeta = {
  path: string;
  byteSize: number;
  sha256: string;
  mime: string;
};

export type MigrationProjectMeta = {
  id: string;
  name: string;
  stationCount: number;
  alignmentMarkerCount: number;
  georefPointCount: number;
  files: {
    pdf: MigrationFileMeta | null;
    plan: MigrationFileMeta | null;
  };
};

export type MigrationManifest = {
  format: typeof MIGRATION_FORMAT;
  formatVersion: typeof MIGRATION_FORMAT_VERSION;
  exportedAt: string;
  origin: string;
  projects: MigrationProjectMeta[];
};

export type MigrationProjectPayload = {
  project: EarthworkProject;
  gprc: GprcRecord;
};

export type HostedFileMeta = {
  byteSize: number;
  mime: string;
};

export type ImportAction = "import" | "skip" | "overwrite" | "fail";

export type ImportFilePlan = {
  incoming: MigrationFileMeta | null;
  hosted: HostedFileMeta | null;
  action: "upload" | "skip" | "replace" | "reject" | "none";
  reason: string | null;
};

export type ImportItemResult = {
  id: string;
  name: string;
  action: ImportAction;
  reason: string | null;
  stations: { incoming: number; hosted: number | null };
  alignmentMarkerCount: number;
  georefPointCount: number;
  files: { pdf: ImportFilePlan; plan: ImportFilePlan };
};

export type ImportReport = {
  dryRun: boolean;
  origin: string | null;
  results: ImportItemResult[];
  totals: {
    incomingProjects: number;
    imported: number;
    skipped: number;
    overwritten: number;
    failed: number;
    incomingStations: number;
    hostedStations: number;
    incomingFiles: number;
    hostedFiles: number;
    filesToUpload: number;
    filesRejected: number;
  };
};

export type ImportRequestBody = {
  dryRun?: boolean;
  overwriteIds?: string[];
  origin?: string | null;
  items: Array<{
    project: unknown;
    gprc?: unknown;
    files?: {
      pdf?: MigrationFileMeta | null;
      plan?: MigrationFileMeta | null;
    };
  }>;
};
