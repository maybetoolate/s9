import { z } from 'zod';
import { LIMITS } from './limits.js';

/**
 * Action configuration schemas.
 *
 * These live in the core package so the API can validate a draft, the worker
 * can validate a pinned version, and the UI can render the same forms. The
 * runtime executors live in the server package and register themselves in the
 * action registry.
 */

export const ACTION_TYPES = ['http_request', 'send_email', 'database_insert', 'notification'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const UrlField = z.string().min(1, 'a URL is required').max(2048);

/** HTTP request action. */
export const HttpRequestConfigSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  url: UrlField,
  headers: z.record(z.string(), z.string()).default({}),
  /** Request body template. `{{...}}` variables are interpolated. */
  body: z.string().max(64_000).optional(),
  bodyType: z.enum(['json', 'text', 'form']).default('json'),
  timeoutMs: z.number().int().min(1_000).max(LIMITS.maxStepTimeoutMs).default(LIMITS.defaultStepTimeoutMs),
  /** Credential holding an auth header value. Secrets never live in the definition. */
  credentialId: z.string().uuid().optional(),
  /** Explicitly allow a private/internal destination. Off by default (SSRF). */
  allowPrivateNetwork: z.boolean().default(false),
  /** Header used to forward the step idempotency key, when the provider supports one. */
  idempotencyHeader: z.string().min(1).max(128).optional(),
  /** Run the real side effect even during a test run. Off by default. */
  executeForReal: z.boolean().optional(),
});

/** Email action. */
export const EmailConfigSchema = z.object({
  provider: z.enum(['resend', 'mailpit']).default('mailpit'),
  from: z.string().min(1, 'a sender address is required').max(320),
  to: z.string().min(1, 'a recipient is required').max(320),
  subject: z.string().min(1, 'a subject is required').max(500),
  body: z.string().max(100_000).default(''),
  credentialId: z.string().uuid().optional(),
  /** Provider header used to carry the idempotency key. */
  idempotencyHeader: z.string().min(1).max(128).optional(),
  /** Run the real side effect even during a test run. Off by default. */
  executeForReal: z.boolean().optional(),
});

/** Database insert action (s9 managed contacts table only). */
export const DatabaseInsertConfigSchema = z.object({
  table: z.literal('contacts').default('contacts'),
  values: z.object({
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    message: z.string().max(10_000).optional(),
    source: z.string().max(200).optional(),
  }),
  /** Business key used for the idempotent upsert. */
  dedupeKey: z.string().max(200).optional(),
  /** Run the real side effect even during a test run. Off by default. */
  executeForReal: z.boolean().optional(),
});

/** Notification action (Slack style incoming webhook). */
export const NotificationConfigSchema = z.object({
  channel: z.string().min(1, 'a channel is required').max(200),
  message: z.string().min(1, 'a message is required').max(10_000),
  /** The destination URL. Prefer a credential: webhook URLs are secrets. */
  webhookUrl: UrlField.optional(),
  credentialId: z.string().uuid().optional(),
  idempotencyHeader: z.string().min(1).max(128).optional(),
  /** Run the real side effect even during a test run. Off by default. */
  executeForReal: z.boolean().optional(),
});

export type HttpRequestConfig = z.infer<typeof HttpRequestConfigSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type DatabaseInsertConfig = z.infer<typeof DatabaseInsertConfigSchema>;
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

export interface ActionMetadata {
  type: ActionType;
  label: string;
  description: string;
  configSchema: z.ZodType;
  /** Keys that must be present for the action to be valid. */
  requiredFields: string[];
  /** Whether repeating the action is safe by default (no duplicate side effect). */
  defaultSafeToRepeat: boolean;
  /** Fields that must never be echoed back to the client after saving. */
  secretFields: string[];
}

export const ACTION_METADATA: Record<ActionType, ActionMetadata> = {
  http_request: {
    type: 'http_request',
    label: 'HTTP request',
    description: 'Call a configured HTTP endpoint with a method, headers and body.',
    configSchema: HttpRequestConfigSchema,
    requiredFields: ['url'],
    defaultSafeToRepeat: false,
    secretFields: [],
  },
  send_email: {
    type: 'send_email',
    label: 'Send email',
    description: 'Send a message through the email provider adapter or the local test adapter.',
    configSchema: EmailConfigSchema,
    requiredFields: ['from', 'to', 'subject'],
    defaultSafeToRepeat: false,
    secretFields: [],
  },
  database_insert: {
    type: 'database_insert',
    label: 'Database insert',
    description: 'Insert a row into the s9 managed contacts table using a parameterized upsert.',
    configSchema: DatabaseInsertConfigSchema,
    requiredFields: ['values'],
    defaultSafeToRepeat: true,
    secretFields: [],
  },
  notification: {
    type: 'notification',
    label: 'Notification',
    description: 'Post a message to a supported notification destination.',
    configSchema: NotificationConfigSchema,
    requiredFields: ['channel', 'message'],
    defaultSafeToRepeat: false,
    secretFields: [],
  },
};

export function actionMetadata(type: ActionType): ActionMetadata {
  return ACTION_METADATA[type];
}

/** Parses a configuration object against the schema of the given action type. */
export function parseActionConfig(type: ActionType, config: unknown): z.ZodSafeParseResult<unknown> {
  return ACTION_METADATA[type].configSchema.safeParse(config ?? {});
}
