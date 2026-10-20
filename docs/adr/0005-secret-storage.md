# ADR 0005 — Secret storage and envelope encryption

**Status:** accepted

## Context

Workflow definitions reference provider secrets (an API key, an Authorization header, an incoming webhook URL). Those
secrets must not end up in the definition JSON, in a log line, or in an API response.

## Decision

Secrets live in their own table (`credentials`) and are encrypted with **AES-256-GCM** under a master key that comes
from the environment. Each ciphertext stores the **key id** that produced it, so the master key can be rotated without
rewriting every stored secret at once.

```
ENCRYPTION_KEY  (environment, base64, 32 bytes)
   └─ key id "key-1"
        └─ credentials.encrypted_secret = { ciphertext, iv, authTag, keyId, version }
```

A workflow step references a credential by `credential_id` only. The workspace ownership of the referenced credential is
checked **at publish time and at run time**, so a definition can never reach a credential of another workspace. A
credential that a published workflow still uses cannot be deleted.

The **webhook endpoint** is the exception that proves the rule: to verify an HMAC signature, the server has to
recompute the HMAC, which a hash alone cannot do. The endpoint therefore stores both a hash (so the plaintext can
never leak through the column a developer is likely to read) and the encrypted secret. The previous secret stays
encrypted for the overlap window after a rotation.

Redaction happens in three places: the logger (pino redaction paths), the API (a secret is never serialised into a
response) and the error handling (`sanitizeErrorSummary` masks emails and token shapes in any message that is stored
or displayed).

## Consequences

- A database leak does not reveal the provider secrets. The master key is the only thing that matters, and it lives in
  the environment, not in the database.
- Rotating the master key is a two-step operation: deploy the new key with a new id, then re-encrypt the stored
  secrets. The key id beside each ciphertext makes that possible.
- The worker needs the master key, so the worker is a privileged component. Its access to the database is
  correspondingly scoped.
- The `credential` is resolved inside the action adapter, so the plaintext only exists in memory for the duration of the
  attempt.
- A rotated webhook secret keeps working for an hour, so a rotation does not break senders that have not been updated.

## Alternatives considered

- **Plaintext in the definition.** Rejected outright: the definition is returned by the API, embedded in every version
  and stored many times over.
- **Plaintext in the database, encrypted only in transit.** Rejected: a database dump is the most likely leak.
- **A managed secret manager (Vault, AWS Secrets Manager).** The right answer at scale. It adds an operational
  dependency that a self-hostable MVP should not require; the key id beside the ciphertext is the seam where such a
  provider would be plugged in later.
- **Hash-only webhook secrets.** Secure for comparison, impossible for HMAC verification. The endpoint therefore keeps
  the encrypted secret next to the hash.
