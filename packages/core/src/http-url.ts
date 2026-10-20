import { isIP } from 'node:net';

/**
 * SSRF protection for the HTTP action.
 *
 * Blueprint section 13: "HTTP action URLs can be abused to reach localhost,
 * cloud metadata endpoints, or private networks; validate destinations and
 * re-check resolved addresses to resist DNS rebinding."
 *
 * The URL is validated before the request and the resolved address is
 * re-validated for every connection attempt (see `server/src/actions/http.ts`,
 * which pins the connection to the validated address).
 */

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
  hostname?: string;
  port?: number;
  isPrivate?: boolean;
}

const DEFAULT_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

/** Hostnames that are always blocked, regardless of the resolved address. */
export function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (DEFAULT_BLOCKED_HOSTNAMES.has(normalized)) return true;
  // `.internal`, `.local` and `.localhost` never point at a public service.
  if (/\.(internal|local|localdomain|home\.arpa)$/.test(normalized)) return true;
  return false;
}

/** True when the literal IP address belongs to a non-public range. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100.0/24
  if (a === 203 && b === 0) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%')[0] ?? ip;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // unique local
  if (normalized.startsWith('ff')) return true; // multicast
  // IPv4 mapped addresses (::ffff:10.0.0.1) inherit the IPv4 rules.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Validates the destination of an HTTP action.
 *
 * `allowPrivateNetwork` exists for workflows that intentionally talk to an
 * internal service; it is opt-in and recorded in the audit trail.
 *
 * `allowedHosts` is the operator level allowlist: a hostname on the list may
 * resolve to a private address. It is configured per deployment, not per
 * workflow.
 */
export function validateHttpDestination(
  rawUrl: string,
  options: { allowPrivateNetwork?: boolean; allowedHosts?: readonly string[] } = {},
): UrlValidationResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'the URL is not a valid absolute URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `only http and https URLs are allowed, received "${url.protocol}"` };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;

  if (isBlockedHostname(hostname) && !isAllowedHost(hostname, options.allowedHosts)) {
    return { ok: false, reason: `the host "${hostname}" is not allowed`, hostname, port };
  }

  const literalIp = isIP(hostname);
  if (literalIp && isPrivateIp(hostname)) {
    if (!options.allowPrivateNetwork && !isAllowedHost(hostname, options.allowedHosts)) {
      return {
        ok: false,
        reason: `the address "${hostname}" is a private or internal address`,
        hostname,
        port,
        isPrivate: true,
      };
    }
  }

  return { ok: true, hostname, port, isPrivate: literalIp ? isPrivateIp(hostname) : undefined };
}

/**
 * True when the hostname is on the operator allowlist.
 */
export function isAllowedHost(hostname: string, allowedHosts?: readonly string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

/**
 * Validates a resolved address before a connection is made.
 *
 * This is the DNS-rebinding defence: the hostname may resolve to a public
 * address during validation and to a private one a moment later, so the
 * address is checked again at connection time.
 */
export function validateResolvedAddress(
  address: string,
  options: { allowPrivateNetwork?: boolean; allowedHosts?: readonly string[]; hostname?: string } = {},
): UrlValidationResult {
  const version = isIP(address);
  if (version === 0) {
    return { ok: false, reason: `"${address}" is not an IP address` };
  }
  const hostAllowed =
    options.hostname !== undefined && isAllowedHost(options.hostname, options.allowedHosts);
  if (isPrivateIp(address) && !options.allowPrivateNetwork && !hostAllowed) {
    return {
      ok: false,
      reason: `the resolved address "${address}" is a private or internal address`,
      hostname: address,
      isPrivate: true,
    };
  }
  return { ok: true, hostname: address, isPrivate: isPrivateIp(address) };
}
