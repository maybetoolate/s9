import { env } from '../config/env.js';

/**
 * The operator allowlist for internal destinations.
 *
 * A deployment can name the internal hosts an HTTP or notification action may
 * reach. It is configured per deployment, never per workflow, so a workflow
 * author cannot widen the SSRF boundary on their own.
 */
export function allowedPrivateHosts(): string[] {
  return env()
    .ALLOWED_PRIVATE_HOSTS.split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}
