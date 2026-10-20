import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Every process (api, worker, scheduler) reads the same environment contract.
 * Secrets never live in version control; see `.env.example`.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** PostgreSQL connection string. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Redis connection string used by BullMQ. */
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  API_HOST: z.string().default('0.0.0.0'),
  /** Public base URL of the API, used to build webhook URLs. */
  API_PUBLIC_URL: z.string().default('http://localhost:4100'),
  /** Public base URL of the web app. */
  WEB_PUBLIC_URL: z.string().default('http://localhost:3000'),

  /** Better-Auth secret used to sign sessions. */
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  /** Base64 encoded 32 byte master key for envelope encryption. */
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),
  /** Identifier of the active master key, stored beside each ciphertext. */
  ENCRYPTION_KEY_ID: z.string().default('key-1'),

  /** Identifier of this worker process. */
  WORKER_ID: z.string().default('worker-1'),
  /** Concurrency of the BullMQ worker. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),

  /** Email provider: `resend` for real delivery, `mailpit` for the local catcher. */
  EMAIL_PROVIDER: z.enum(['resend', 'mailpit']).default('mailpit'),
  RESEND_API_KEY: z.string().optional(),
  MAILPIT_URL: z.string().default('http://localhost:8025'),

  /**
   * Hostnames that may resolve to a private address.
   *
   * An operator level allowlist for internal services. It is separate from the
   * per step `allowPrivateNetwork` flag.
   */
  ALLOWED_PRIVATE_HOSTS: z.string().default(''),

  /** Where the seed/demo data is written to. */
  SEED_WORKSPACE_NAME: z.string().default('FlowForge Demo'),
  SEED_USER_EMAIL: z.string().default('operator@flowforge.local'),
  SEED_USER_PASSWORD: z.string().default('flowforge-demo-password'),
  SEED_USER_NAME: z.string().default('Demo Operator'),
  /** The destination of the notification step in the demo workflow. */
  DEMO_NOTIFICATION_URL: z.string().default('http://localhost:8081/notify'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper: forces a re-read of the environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
