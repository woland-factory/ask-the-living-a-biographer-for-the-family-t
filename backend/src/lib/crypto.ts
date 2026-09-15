import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

/** A URL-safe random token (32 bytes of entropy). The raw value is never stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// --- Secret-at-rest encryption (AES-256-GCM) -------------------------------
// Used to store a user's BYOK API key. The plaintext key exists in memory only
// at store time and at call time; the database only ever holds ciphertext.

export interface SealedSecret {
  ciphertext: string; // base64
  iv: string; // base64 (12-byte GCM nonce)
  tag: string; // base64 (GCM auth tag)
}

/** Derive a 32-byte key from arbitrary secret material with a fixed salt. */
export function deriveKey(material: string): Buffer {
  return scryptSync(material, "atl-llm-cred", 32);
}

/** Encrypt a UTF-8 plaintext. Each call uses a fresh random nonce. */
export function encryptSecret(plaintext: string, material: string): SealedSecret {
  const key = deriveKey(material);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** Decrypt a sealed secret. Throws if the material or the auth tag is wrong. */
export function decryptSecret(sealed: SealedSecret, material: string): string {
  const key = deriveKey(material);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
