/**
 * The auth module.
 *
 * Authentication is embedded in the API process but kept behind this module
 * boundary: callers resolve sessions, read a profile and forward auth HTTP
 * requests through these exports. Better-Auth's instance and its tables stay
 * private to `src/auth`, so the module could be moved into its own service
 * later without changing the API code.
 */

export { auth } from './instance.js';
export { handleAuthRequest } from './http.js';
export { validateSession, getUserProfile } from './session.js';
export type { SessionInfo, UserProfile } from './session.js';
