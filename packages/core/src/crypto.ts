import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Secret handling.
 *
 * Blueprint section 13: "Encrypt secrets with envelope encryption: a rotatable
 * master key, with a key ID stored beside each ciphertext."
 *
 * The master key is supplied through the environment (a 32 byte key, base64
 * encoded). Each ciphertext carries a key id so the master key can be rotated
 * without rewriting stored secrets immediately.
 */

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTION_KEY_BYTES = 32;
export const ENCRYPTION_IV_BYTES = 12;

export interface EncryptedSecret {
  /** Base64 ciphertext (including the auth tag). */
  ciphertext: string;
  /** Base64 initialisation vector. */
  iv: string;
  /** Base64 auth tag. */
  authTag: string;
  /** Identifies the master key used, so the key can be rotated. */
  keyId: string;
  /** Algorithm version for future migrations. */
  version: 1;
}

export function decodeMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `master key must decode to ${ENCRYPTION_KEY_BYTES} bytes, received ${key.length}. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Encrypts a secret with AES-256-GCM. */
export function encryptSecret(plaintext: string, masterKey: Buffer, keyId: string): EncryptedSecret {
  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyId,
    version: 1,
  };
}

/** Decrypts a secret produced by `encryptSecret`. */
export function decryptSecret(encrypted: EncryptedSecret, masterKey: Buffer): string {
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, masterKey, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Derives the public half of a webhook secret.
 *
 * The endpoint stores a hash of the secret so a database leak does not reveal
 * the signing key; the plaintext secret is shown once at creation time.
 */
export function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/**
 * Computes the webhook signature.
 *
 * Blueprint: "HMAC-SHA256 over timestamp plus body with a 5-minute tolerance."
 * The signed payload is `${timestamp}.${rawBody}`.
 */
export function signWebhookPayload(secret: string, timestamp: number, rawBody: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${rawBody}`);
  return hmac.digest('hex');
}

export interface WebhookSignatureHeader {
  timestamp: number;
  signatures: string[];
}

/** Parses an `X-S9-Signature` header of the form `t=...,v1=...`. */
export function parseSignatureHeader(header: string): WebhookSignatureHeader | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (!key || !value) continue;
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Constant-time signature comparison. */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  toleranceMs: number,
  now: number = Date.now(),
): { valid: boolean; reason?: string } {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'malformed signature header' };

  if (Math.abs(now - parsed.timestamp) > toleranceMs) {
    return { valid: false, reason: 'signature timestamp outside the tolerance window' };
  }

  const expected = signWebhookPayload(secret, parsed.timestamp, rawBody);
  const expectedBuffer = Buffer.from(expected, 'hex');
  for (const candidate of parsed.signatures) {
    const candidateBuffer = Buffer.from(candidate, 'hex');
    if (candidateBuffer.length !== expectedBuffer.length) continue;
    if (timingSafeEqual(candidateBuffer, expectedBuffer)) return { valid: true };
  }
  return { valid: false, reason: 'signature mismatch' };
}

/** Hash used to compare secrets without storing them. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
