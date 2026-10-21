import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

/** RFC 7914 scrypt, from Node's crypto. The stored form records the parameters. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const rr = Number(parts[2]);
  const pp = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (!n || !rr || !pp || salt.length === 0 || expected.length === 0) return false;
  const key = scryptSync(password, salt, expected.length, { N: n, r: rr, p: pp });
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}
