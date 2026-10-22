import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MAX_UPLOAD_BYTES } from "./limits";

export { MAX_UPLOAD_BYTES };

const memory = new Map<string, { body: Buffer; mime: string }>();

function driver(): "memory" | "disk" | "s3" {
  const value = process.env.OBJECT_STORE;
  const production = process.env.NODE_ENV === "production";
  if (value === "memory" || value === "disk") {
    if (production) {
      throw new Error(
        "OBJECT_STORE=memory and OBJECT_STORE=disk are not allowed in production. Set OBJECT_STORE=s3 plus S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
      );
    }
    return value;
  }
  if (value && value !== "s3") {
    throw new Error(`Unknown OBJECT_STORE=${value}. Use s3, or disk/memory only in local development.`);
  }
  return "s3";
}

function diskRoot(): string {
  return process.env.OBJECT_DIR || join(/* turbopackIgnore: true */ process.cwd(), "data", "objects");
}

function diskPath(key: string): string {
  return join(/* turbopackIgnore: true */ diskRoot(), key);
}

function mimePath(key: string): string {
  return `${diskPath(key)}.mime`;
}

function client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION || "auto";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey || !process.env.S3_BUCKET) {
    throw new Error("Object storage is not configured. Set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.");
  }
  return new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export async function putObject(key: string, body: Buffer, mime: string): Promise<void> {
  const mode = driver();
  if (mode === "memory") {
    memory.set(key, { body, mime });
    return;
  }
  if (mode === "disk") {
    const path = diskPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await writeFile(mimePath(key), mime, "utf8");
    return;
  }
  await client().send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: body, ContentType: mime }));
}

export async function getObject(key: string): Promise<{ body: Buffer; mime: string } | null> {
  const mode = driver();
  if (mode === "memory") return memory.get(key) ?? null;
  if (mode === "disk") {
    try {
      const body = await readFile(/* turbopackIgnore: true */ diskPath(key));
      const mime = await readFile(/* turbopackIgnore: true */ mimePath(key), "utf8").catch(() => "application/octet-stream");
      return { body, mime: mime.trim() || "application/octet-stream" };
    } catch {
      return null;
    }
  }
  try {
    const result = await client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) return null;
    return { body: Buffer.from(bytes), mime: result.ContentType || "application/octet-stream" };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  const mode = driver();
  if (mode === "memory") {
    memory.delete(key);
    return;
  }
  if (mode === "disk") {
    await rm(diskPath(key), { force: true });
    await rm(mimePath(key), { force: true });
    return;
  }
  await client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
}

export function resetMemoryObjects(): void {
  memory.clear();
}
