import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM for secrets stored in the database (connector credentials).
// GCM authenticates as well as encrypts, so a tampered value fails to
// decrypt instead of decrypting to garbage.
//
// Stored as `v1:<iv>:<tag>:<ciphertext>` (base64url). The version prefix is
// for key rotation: a future v2 can use a new key while v1 rows still read.

function key(): Buffer {
  const raw = process.env.CONNECTION_ENCRYPTION_KEY;
  const bytes = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (bytes.length !== 32) {
    throw new Error("CONNECTION_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  return bytes;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unrecognized encrypted secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
