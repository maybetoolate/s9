import {
  generateWebhookSecret,
  hashWebhookSecret,
  randomSlug,
  validateDefinition,
  type WorkflowDefinition,
} from '@s9/core';
import { and, eq } from 'drizzle-orm';
import { addMembership, createWorkflow, getDraft, insertWebhookEndpoint, listWorkspacesForUser } from './repo.js';
import { getDb, withTransaction } from './client.js';
import { runMigrations } from './migrate.js';
import { user, webhookEndpoints, workflows, workspaces } from './schema.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { encrypt } from '../lib/secrets.js';

/**
 * Seed data.
 *
 * Creates the demo workspace, the demo operator and one complete workflow:
 * the contact form follow-up from the blueprint (webhook -> save contact ->
 * send email -> notify sales).
 */

const DEMO_DEFINITION: WorkflowDefinition = {
  trigger: {
    type: 'webhook',
    slug: randomSlug(12),
    requireSignature: true,
    samplePayload: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'I would like a demo of s9.',
    },
  },
  steps: [
    {
      key: 'save_contact',
      name: 'Save contact',
      type: 'database_insert',
      config: {
        table: 'contacts',
        values: {
          name: '{{trigger.body.name}}',
          email: '{{trigger.body.email}}',
          message: '{{trigger.body.message}}',
          source: 'website',
        },
        dedupeKey: '{{trigger.body.email}}',
      },
    },
    {
      key: 'send_confirmation',
      name: 'Send confirmation email',
      type: 'send_email',
      config: {
        provider: 'mailpit',
        from: 's9 <no-reply@s9.local>',
        to: '{{trigger.body.email}}',
        subject: 'We received your message',
        body: 'Thanks for reaching out. We will get back to you shortly.',
      },
    },
    {
      key: 'notify_sales',
      name: 'Notify sales',
      type: 'notification',
      config: {
        channel: 'sales',
        message: 'New contact from {{trigger.body.name}} ({{trigger.body.email}})',
        webhookUrl: env().DEMO_NOTIFICATION_URL,
      },
    },
  ],
  policy: {
    maxSteps: 10,
    executionTimeoutMs: 600_000,
    concurrency: 1,
    retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 300_000, timeoutMs: 30_000 },
  },
};

async function seed(): Promise<void> {
  const config = env();
  await runMigrations({ log: false });

  // Imported after migrations: Better-Auth validates its schema when the
  // instance is created, so the auth tables must already exist.
  const { auth } = await import('../auth/index.js');

  const db = getDb();

  // The demo operator.
  let userId: string | undefined;
  try {
    const result = await auth.api.signUpEmail({
      body: {
        email: config.SEED_USER_EMAIL,
        password: config.SEED_USER_PASSWORD,
        name: config.SEED_USER_NAME,
      },
    });
    userId = result.user.id;
    logger.info({ email: config.SEED_USER_EMAIL }, 'the demo user was created');
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (!/already|exists|registered/i.test(message)) throw error;
    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, config.SEED_USER_EMAIL))
      .limit(1);
    userId = existing?.id;
    logger.info({ email: config.SEED_USER_EMAIL }, 'the demo user already exists');
  }

  if (!userId) throw new Error('the demo user could not be created or found');

  // The workspace.
  let workspaceId: string;
  const existingWorkspaces = await listWorkspacesForUser(db, userId);
  const existing = existingWorkspaces[0];
  if (existing) {
    workspaceId = existing.id;
  } else {
    const workspace = await withTransaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ name: config.SEED_WORKSPACE_NAME })
        .returning({ id: workspaces.id });
      const id = created?.id as string;
      await addMembership(tx, id, userId as string, 'owner');
      return { id };
    });
    workspaceId = workspace.id;
  }

  // The demo workflow.
  const [existingWorkflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspace_id, workspaceId),
        eq(workflows.name, 'Contact form follow-up'),
      ),
    )
    .limit(1);

  if (existingWorkflow) {
    logger.info('the demo workflow already exists');
    await printSummary(workspaceId, userId, null);
    return;
  }

  const issues = validateDefinition(DEMO_DEFINITION);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`the demo definition is not valid: ${JSON.stringify(errors)}`);
  }

  const secret = generateWebhookSecret();

  const workflow = await withTransaction(async (client) => {
    const created = await createWorkflow(client, {
      workspaceId,
      name: 'Contact form follow-up',
      description: 'Saves the contact, sends a confirmation email and notifies the sales channel.',
      triggerType: 'webhook',
      definition: DEMO_DEFINITION,
    });

    const endpoint = await insertWebhookEndpoint(client, {
      workflowId: created.id,
      slug: DEMO_DEFINITION.trigger.type === 'webhook' ? DEMO_DEFINITION.trigger.slug : randomSlug(12),
      secretHash: hashWebhookSecret(secret),
      encryptedSecret: encrypt(secret),
      requireSignature: true,
    });

    return { id: created.id, slug: endpoint.slug };
  });

  logger.info(
    { workflowId: workflow.id, slug: workflow.slug },
    'the demo workflow was created (publish it from the UI to activate it)',
  );
  await warnIfUnreachable(env().DEMO_NOTIFICATION_URL);
  await printSummary(workspaceId, userId, secret);
}

/**
 * Warns when the demo notification destination is not reachable.
 *
 * The seed stores the destination in the workflow definition, so it has to be
 * reachable from the worker, not from the process that seeds the database.
 */
async function warnIfUnreachable(url: string): Promise<void> {
  try {
    await fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(2_000) });
  } catch {
    logger.warn(
      { url },
      'the demo notification destination is not reachable from here; run the seed in the environment where the worker runs, or set DEMO_NOTIFICATION_URL',
    );
  }
}

async function printSummary(
  workspaceId: string,
  userId: string,
  webhookSecret: string | null,
): Promise<void> {
  const db = getDb();
  const [endpoint] = await db
    .select({ slug: webhookEndpoints.slug })
    .from(webhookEndpoints)
    .innerJoin(workflows, eq(workflows.id, webhookEndpoints.workflow_id))
    .where(eq(workflows.workspace_id, workspaceId))
    .limit(1);

  const config = env();
  logger.info(
    {
      workspace: workspaceId,
      user: userId,
      email: config.SEED_USER_EMAIL,
      password: config.SEED_USER_PASSWORD,
      webhookUrl: endpoint ? `${config.API_PUBLIC_URL}/webhooks/${endpoint.slug}` : undefined,
      // The signing secret is printed once so the demo can be tried immediately.
      ...(webhookSecret ? { webhookSecret } : {}),
    },
    'seed complete',
  );
}


export { seed, DEMO_DEFINITION };
export { getDraft };
