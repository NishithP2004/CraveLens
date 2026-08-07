import crypto from "node:crypto";
import { config } from "./config.js";

function encryptionKey() {
  const source = config.credentialEncryptionKey;
  if (!source) throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");
  if (/^[a-f0-9]{64}$/i.test(source)) return Buffer.from(source, "hex");
  try {
    const decoded = Buffer.from(source, "base64");
    if (decoded.length === 32) return decoded;
  } catch { /* report the common validation error below */ }
  throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64");
}

export function encryptJson(value, additionalData = "cravelens:v1") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(additionalData));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") });
}

export function decryptJson(payload, additionalData = "cravelens:v1") {
  const envelope = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (envelope?.version !== 1) throw new Error("Unsupported encrypted credential version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(additionalData));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
