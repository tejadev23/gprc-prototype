import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { parseGprcBody, parseImportedProject } from "@/lib/projects/validate";
import { isSha256Hex } from "./hash";
import { alignmentMarkerCount, georefPointCount } from "./counts";
import {
  MIGRATION_FORMAT,
  MIGRATION_FORMAT_VERSION,
  type MigrationFileMeta,
  type MigrationManifest,
  type MigrationProjectMeta,
  type MigrationProjectPayload,
} from "./types";

export class BadMigrationArchive extends Error {}

export type PackedMigrationProject = {
  meta: MigrationProjectMeta;
  payload: MigrationProjectPayload;
  files: { pdf: Uint8Array | null; plan: Uint8Array | null };
};

function asMeta(value: unknown): MigrationFileMeta | null {
  if (value == null) return null;
  if (!value || typeof value !== "object") throw new BadMigrationArchive("A file entry is invalid.");
  const raw = value as Partial<MigrationFileMeta>;
  if (typeof raw.path !== "string" || !raw.path) throw new BadMigrationArchive("A file path is missing.");
  if (!Number.isInteger(raw.byteSize) || (raw.byteSize as number) < 0) {
    throw new BadMigrationArchive("A file size is invalid.");
  }
  if (typeof raw.sha256 !== "string" || !isSha256Hex(raw.sha256)) {
    throw new BadMigrationArchive("A file hash is invalid.");
  }
  if (typeof raw.mime !== "string" || !raw.mime) throw new BadMigrationArchive("A file type is missing.");
  return { path: raw.path, byteSize: raw.byteSize as number, sha256: raw.sha256.toLowerCase(), mime: raw.mime };
}

export function parseManifest(value: unknown): MigrationManifest {
  if (!value || typeof value !== "object") throw new BadMigrationArchive("manifest.json is missing.");
  const raw = value as Partial<MigrationManifest>;
  if (raw.format !== MIGRATION_FORMAT) throw new BadMigrationArchive("This file is not a GPRC migration archive.");
  if (raw.formatVersion !== MIGRATION_FORMAT_VERSION) {
    throw new BadMigrationArchive("This migration archive uses an unsupported version.");
  }
  if (typeof raw.exportedAt !== "string" || typeof raw.origin !== "string") {
    throw new BadMigrationArchive("The migration manifest is incomplete.");
  }
  if (!Array.isArray(raw.projects)) throw new BadMigrationArchive("The migration manifest has no projects.");
  return {
    format: MIGRATION_FORMAT,
    formatVersion: MIGRATION_FORMAT_VERSION,
    exportedAt: raw.exportedAt,
    origin: raw.origin,
    projects: raw.projects.map((project) => {
      if (!project || typeof project !== "object") throw new BadMigrationArchive("A project entry is invalid.");
      const item = project as Partial<MigrationProjectMeta>;
      if (typeof item.id !== "string" || typeof item.name !== "string") {
        throw new BadMigrationArchive("A project entry is missing an id or name.");
      }
      if (!Number.isInteger(item.stationCount) || (item.stationCount as number) < 0) {
        throw new BadMigrationArchive(`Project ${item.name} has an invalid station count.`);
      }
      return {
        id: item.id,
        name: item.name,
        stationCount: item.stationCount as number,
        alignmentMarkerCount: Number.isInteger(item.alignmentMarkerCount) ? (item.alignmentMarkerCount as number) : 0,
        georefPointCount: Number.isInteger(item.georefPointCount) ? (item.georefPointCount as number) : 0,
        files: {
          pdf: asMeta(item.files?.pdf ?? null),
          plan: asMeta(item.files?.plan ?? null),
        },
      };
    }),
  };
}

export function packMigrationZip(projects: PackedMigrationProject[], origin: string, exportedAt = new Date().toISOString()): Uint8Array {
  const manifest: MigrationManifest = {
    format: MIGRATION_FORMAT,
    formatVersion: MIGRATION_FORMAT_VERSION,
    exportedAt,
    origin,
    projects: projects.map((item) => item.meta),
  };
  const files: Zippable = {
    "manifest.json": [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 6 }],
  };
  for (const item of projects) {
    const json = JSON.stringify(item.payload);
    files[`projects/${item.meta.id}.json`] = [strToU8(json), { level: 6 }];
    if (item.files.pdf && item.meta.files.pdf) {
      files[item.meta.files.pdf.path] = [item.files.pdf, { level: 0 }];
    }
    if (item.files.plan && item.meta.files.plan) {
      files[item.meta.files.plan.path] = [item.files.plan, { level: 0 }];
    }
  }
  return zipSync(files);
}

function readZipFile(zip: Record<string, Uint8Array>, path: string): Uint8Array {
  const data = zip[path];
  if (!data) throw new BadMigrationArchive(`The archive is missing ${path}.`);
  return data;
}

export async function unpackMigrationZip(bytes: Uint8Array, sha256: (data: Uint8Array) => Promise<string>): Promise<{
  manifest: MigrationManifest;
  projects: PackedMigrationProject[];
}> {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(bytes);
  } catch {
    throw new BadMigrationArchive("This file is not a zip archive.");
  }
  const manifest = parseManifest(JSON.parse(strFromU8(readZipFile(zip, "manifest.json"))));
  const projects: PackedMigrationProject[] = [];
  for (const meta of manifest.projects) {
    const payloadRaw = JSON.parse(strFromU8(readZipFile(zip, `projects/${meta.id}.json`))) as {
      project?: unknown;
      gprc?: unknown;
    };
    const project = parseImportedProject(payloadRaw.project);
    if (project.id !== meta.id) throw new BadMigrationArchive(`Project ${meta.id} does not match its JSON id.`);
    const gprc = parseGprcBody(payloadRaw.gprc);
    if (project.stations.length !== meta.stationCount) {
      throw new BadMigrationArchive(`Project ${project.name} station count does not match the manifest.`);
    }
    if (alignmentMarkerCount(gprc) !== meta.alignmentMarkerCount) {
      throw new BadMigrationArchive(`Project ${project.name} alignment marker count does not match the manifest.`);
    }
    if (georefPointCount(gprc) !== meta.georefPointCount) {
      throw new BadMigrationArchive(`Project ${project.name} georeference point count does not match the manifest.`);
    }
    const files = {
      pdf: meta.files.pdf ? readZipFile(zip, meta.files.pdf.path) : null,
      plan: meta.files.plan ? readZipFile(zip, meta.files.plan.path) : null,
    };
    for (const kind of ["pdf", "plan"] as const) {
      const info = meta.files[kind];
      const data = files[kind];
      if (!info && data) throw new BadMigrationArchive(`Project ${project.name} has unexpected ${kind} bytes.`);
      if (info && !data) throw new BadMigrationArchive(`Project ${project.name} is missing ${kind} bytes.`);
      if (info && data) {
        if (data.byteLength !== info.byteSize) {
          throw new BadMigrationArchive(`Project ${project.name} ${kind} size does not match the manifest.`);
        }
        const hash = await sha256(data);
        if (hash !== info.sha256) {
          throw new BadMigrationArchive(`Project ${project.name} ${kind} hash does not match the manifest.`);
        }
      }
    }
    projects.push({ meta, payload: { project, gprc }, files });
  }
  return { manifest, projects };
}
