-- OAuth provider tables.
--
-- The API authenticates to the auth service with the OAuth2
-- client-credentials grant. The authorization server, its client registry and
-- the issued token records are owned by the maintained OAuth provider plugin;
-- the schema matches its default PostgreSQL models.

CREATE TABLE IF NOT EXISTS "jwks" (
  "id"        TEXT PRIMARY KEY,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP,
  "alg"       TEXT,
  "crv"       TEXT
);

CREATE TABLE IF NOT EXISTS "oauthClient" (
  "id"                            TEXT PRIMARY KEY,
  "clientId"                      TEXT NOT NULL UNIQUE,
  "clientSecret"                  TEXT,
  "clientDiscoveryId"             TEXT,
  "disabled"                      BOOLEAN DEFAULT FALSE,
  "skipConsent"                   BOOLEAN,
  "enableEndSession"              BOOLEAN,
  "subjectType"                   TEXT,
  "scopes"                        TEXT,
  "clientCredentialsScopes"       TEXT DEFAULT '[]',
  "userId"                        TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt"                     TIMESTAMP,
  "updatedAt"                     TIMESTAMP,
  "name"                          TEXT,
  "uri"                           TEXT,
  "icon"                          TEXT,
  "contacts"                      TEXT,
  "tos"                           TEXT,
  "policy"                        TEXT,
  "softwareId"                    TEXT,
  "softwareVersion"               TEXT,
  "softwareStatement"             TEXT,
  "redirectUris"                  TEXT NOT NULL,
  "postLogoutRedirectUris"        TEXT,
  "backchannelLogoutUri"          TEXT,
  "backchannelLogoutSessionRequired" BOOLEAN,
  "tokenEndpointAuthMethod"       TEXT,
  "applicationType"               TEXT,
  "jwks"                          TEXT,
  "jwksUri"                       TEXT,
  "grantTypes"                    TEXT,
  "responseTypes"                 TEXT,
  "requirePKCE"                   BOOLEAN,
  "dpopBoundAccessTokens"         BOOLEAN DEFAULT FALSE,
  "referenceId"                   TEXT,
  "metadata"                      JSONB
);

CREATE INDEX IF NOT EXISTS oauth_client_user_idx ON "oauthClient" ("userId");

CREATE TABLE IF NOT EXISTS "oauthResource" (
  "id"                            TEXT PRIMARY KEY,
  "identifier"                    TEXT NOT NULL UNIQUE,
  "name"                          TEXT NOT NULL,
  "accessTokenTtl"                INTEGER,
  "refreshTokenTtl"               INTEGER,
  "signingAlgorithm"              TEXT,
  "signingKeyId"                  TEXT,
  "allowedScopes"                 TEXT,
  "customClaims"                  JSONB,
  "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT FALSE,
  "disabled"                      BOOLEAN DEFAULT FALSE,
  "createdAt"                     TIMESTAMP,
  "updatedAt"                     TIMESTAMP,
  "policyVersion"                 INTEGER DEFAULT 1,
  "metadata"                      JSONB
);

CREATE TABLE IF NOT EXISTS "oauthClientResource" (
  "id"         TEXT PRIMARY KEY,
  "clientId"   TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" TEXT NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP
);

CREATE INDEX IF NOT EXISTS oauth_client_resource_client_idx
  ON "oauthClientResource" ("clientId");
CREATE INDEX IF NOT EXISTS oauth_client_resource_resource_idx
  ON "oauthClientResource" ("resourceId");
CREATE UNIQUE INDEX IF NOT EXISTS oauth_client_resource_client_resource_uidx
  ON "oauthClientResource" ("clientId", "resourceId");

CREATE TABLE IF NOT EXISTS "oauthRefreshToken" (
  "id"                       TEXT PRIMARY KEY,
  "token"                    TEXT NOT NULL UNIQUE,
  "clientId"                 TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId"                TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId"                   TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId"              TEXT,
  "authorizationCodeId"      TEXT,
  "resources"                TEXT,
  "requestedUserInfoClaims"  TEXT,
  "expiresAt"                TIMESTAMP,
  "createdAt"                TIMESTAMP,
  "revoked"                  TIMESTAMP,
  "rotatedAt"                TIMESTAMP,
  "rotationReplayResponse"   TEXT,
  "rotationReplayExpiresAt"  TIMESTAMP,
  "authTime"                 TIMESTAMP,
  "confirmation"             JSONB,
  "scopes"                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_refresh_token_client_idx
  ON "oauthRefreshToken" ("clientId");
CREATE INDEX IF NOT EXISTS oauth_refresh_token_session_idx
  ON "oauthRefreshToken" ("sessionId");
CREATE INDEX IF NOT EXISTS oauth_refresh_token_user_idx
  ON "oauthRefreshToken" ("userId");
CREATE INDEX IF NOT EXISTS oauth_refresh_token_code_idx
  ON "oauthRefreshToken" ("authorizationCodeId");

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  "id"                       TEXT PRIMARY KEY,
  "token"                    TEXT UNIQUE,
  "clientId"                 TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId"                TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId"                   TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId"              TEXT,
  "authorizationCodeId"      TEXT,
  "resources"                TEXT,
  "requestedUserInfoClaims"  TEXT,
  "refreshId"                TEXT REFERENCES "oauthRefreshToken" ("id") ON DELETE SET NULL,
  "expiresAt"                TIMESTAMP,
  "createdAt"                TIMESTAMP,
  "revoked"                  TIMESTAMP,
  "confirmation"             JSONB,
  "scopes"                   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_access_token_client_idx
  ON "oauthAccessToken" ("clientId");
CREATE INDEX IF NOT EXISTS oauth_access_token_session_idx
  ON "oauthAccessToken" ("sessionId");
CREATE INDEX IF NOT EXISTS oauth_access_token_user_idx
  ON "oauthAccessToken" ("userId");
CREATE INDEX IF NOT EXISTS oauth_access_token_code_idx
  ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX IF NOT EXISTS oauth_access_token_refresh_idx
  ON "oauthAccessToken" ("refreshId");

CREATE TABLE IF NOT EXISTS "oauthConsent" (
  "id"                       TEXT PRIMARY KEY,
  "clientId"                 TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId"                   TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId"              TEXT,
  "resources"                TEXT,
  "requestedUserInfoClaims"  TEXT,
  "scopes"                   TEXT NOT NULL,
  "createdAt"                TIMESTAMP,
  "updatedAt"                TIMESTAMP
);

CREATE INDEX IF NOT EXISTS oauth_consent_client_idx ON "oauthConsent" ("clientId");
CREATE INDEX IF NOT EXISTS oauth_consent_user_idx ON "oauthConsent" ("userId");

CREATE TABLE IF NOT EXISTS "oauthClientAssertion" (
  "id"        TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_client_assertion_expires_idx
  ON "oauthClientAssertion" ("expiresAt");
