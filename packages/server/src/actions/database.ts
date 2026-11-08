import { z } from 'zod';
import {
  DatabaseInsertConfigSchema,
  S9Error,
  sanitizeErrorSummary,
  type ActionContext,
  type ActionExecutor,
  type ActionResult,
  type ClassifiedError,
} from '@s9/core';
import { upsertContact } from '../db/repo.js';
import { getPool } from '../db/pool.js';

/**
 * The database insert action.
 *
 * It writes into the s9 managed contacts table only: the table and
 * the columns are fixed, values are parameterized and a business key turns
 * the write into an idempotent upsert. Arbitrary SQL is never accepted.
 */

const OutputSchema = z.object({
  contactId: z.string(),
  created: z.boolean(),
  dedupeKey: z.string().optional(),
});

export class DatabaseInsertExecutor implements ActionExecutor {
  readonly type = 'database_insert';
  readonly configSchema = DatabaseInsertConfigSchema;
  readonly outputSchema = OutputSchema;
  // The write is an idempotent upsert, so repeating it is safe.
  readonly safeToRepeat = true;
  readonly redactionKeys = ['values'];

  validateConfig(config: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
    const parsed = DatabaseInsertConfigSchema.safeParse(config ?? {});
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues.map((issue) => issue.message).join('; ') };
    }
    return { ok: true, value: parsed.data };
  }

  async execute(context: ActionContext): Promise<ActionResult> {
    const config = DatabaseInsertConfigSchema.parse(context.input);

    if (context.simulate) {
      return {
        output: {
          contactId: `simulated-${context.executionId}-${context.stepKey}`,
          created: true,
          ...(config.dedupeKey ? { dedupeKey: config.dedupeKey } : {}),
        },
      };
    }

    try {
      const row = await upsertContact(getPool(), {
        name: config.values.name ?? null,
        email: config.values.email ?? null,
        message: config.values.message ?? null,
        source: config.values.source ?? null,
        dedupeKey: config.dedupeKey ?? null,
      });

      return {
        output: {
          contactId: row.id,
          created: true,
          ...(config.dedupeKey ? { dedupeKey: config.dedupeKey } : {}),
        },
      };
    } catch (error) {
      throw S9Error.infrastructure(
        sanitizeErrorSummary((error as Error)?.message ?? 'the contact could not be stored'),
        error,
      );
    }
  }

  classifyError(error: unknown): ClassifiedError {
    if (error instanceof S9Error) return error.toClassified();
    return {
      class: 'internal_infrastructure',
      message: sanitizeErrorSummary((error as Error)?.message ?? 'the database write failed'),
      safeToRepeat: true,
    };
  }
}

export function createDatabaseInsertExecutor(): ActionExecutor {
  return new DatabaseInsertExecutor();
}
