import { decodeMasterKey, decryptSecret, encryptSecret, type EncryptedSecret } from '@s9/core';
import { env } from '../config/env.js';

/**
 * Envelope encryption.
 *
 * The master key lives in the environment; each ciphertext stores the key id
 * that produced it, so the master key can be rotated without rewriting every
 * stored secret at once.
 */

let masterKey: Buffer | undefined;

export function getMasterKey(): Buffer {
  masterKey ??= decodeMasterKey(env().ENCRYPTION_KEY);
  return masterKey;
}

export function encrypt(plaintext: string): EncryptedSecret {
  const config = env();
  return encryptSecret(plaintext, getMasterKey(), config.ENCRYPTION_KEY_ID);
}

export function decrypt(encrypted: EncryptedSecret): string {
  return decryptSecret(encrypted, getMasterKey());
}
