import type { Db } from '../db/repo.js';
import { getCredential } from '../db/repo.js';
import { decrypt } from '../lib/secrets.js';
import { S9Error } from '@s9/core';

/**
 * Credential resolution.
 *
 * Workflow definitions reference a credential by id only. Workspace ownership
 * is checked at publish time and at run time, so a definition can never
 * reach a credential of another workspace.
 */

export interface ResolvedCredential {
  id: string;
  provider: string;
  secret: string;
  metadata: Record<string, unknown>;
}

export async function resolveCredential(
  db: Db,
  workspaceId: string,
  credentialId: unknown,
): Promise<ResolvedCredential | undefined> {
  if (typeof credentialId !== 'string' || credentialId.length === 0) return undefined;

  const row = await getCredential(db, workspaceId, credentialId);
  if (!row) {
    throw S9Error.validation(
      'the referenced credential does not exist in this workspace',
      { credentialId },
    );
  }

  let secret: string;
  try {
    secret = decrypt(row.encrypted_secret);
  } catch (error) {
    throw S9Error.infrastructure('the credential could not be decrypted', error);
  }

  return {
    id: row.id,
    provider: row.provider,
    secret,
    metadata: row.metadata ?? {},
  };
}
