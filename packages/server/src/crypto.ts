/**
 * Small crypto helpers built on node:crypto. No external deps.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Constant-time comparison of two hex strings of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Hash a password for storage. Format: `scrypt$N$r$p$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return [
    "scrypt",
    SCRYPT_OPTS.N,
    SCRYPT_OPTS.r,
    SCRYPT_OPTS.p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const opts = { N: Number(nStr), r: Number(rStr), p: Number(pStr) };
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, opts);
  return timingSafeEqual(actual, expected);
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}
