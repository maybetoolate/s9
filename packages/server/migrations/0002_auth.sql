-- Authentication tables.
--
-- These are owned by the maintained authentication library (Better-Auth); the
-- application never implements password or session handling itself. The
-- schema matches the library's default PostgreSQL models.

CREATE TABLE IF NOT EXISTS "user" (
  "id"            TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "email"         TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  "image"         TEXT,
  "createdAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "session" (
  "id"        TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMP NOT NULL,
  "token"     TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId"   TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_user_idx ON "session" ("userId");

CREATE TABLE IF NOT EXISTS "account" (
  "id"                   TEXT PRIMARY KEY,
  "accountId"            TEXT NOT NULL,
  "providerId"           TEXT NOT NULL,
  "userId"               TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken"          TEXT,
  "refreshToken"         TEXT,
  "idToken"              TEXT,
  "accessTokenExpiresAt" TIMESTAMP,
  "refreshTokenExpiresAt" TIMESTAMP,
  "scope"                TEXT,
  "password"             TEXT,
  "createdAt"            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS account_user_idx ON "account" ("userId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id"         TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value"      TEXT NOT NULL,
  "expiresAt"  TIMESTAMP NOT NULL,
  "createdAt"  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification" ("identifier");
