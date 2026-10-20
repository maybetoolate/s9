-- Webhook endpoint secret material.
--
-- The endpoint keeps a hash of the secret (so the plaintext can never leak
-- through the column a developer is likely to read) and the encrypted
-- secret, because the server has to recompute the HMAC to verify a
-- signature. The previous secret is kept encrypted for the overlap window
-- after a rotation.

ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS encrypted_secret jsonb;

ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS previous_encrypted_secret jsonb;
