import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  hashWebhookSecret,
  isBlockedHostname,
  isPrivateIp,
  parseSignatureHeader,
  redactValue,
  sanitizeErrorSummary,
  signWebhookPayload,
  validateHttpDestination,
  validateResolvedAddress,
  verifyWebhookSignature,
} from '@s9/core';

/**
 * Security behaviour: webhook signatures, SSRF protection and redaction.
 */
describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ name: 'Ada' });
  const timestamp = 1_800_000_000_000;

  it('accepts a correct signature', () => {
    const signature = signWebhookPayload(secret, timestamp, body);
    const header = `t=${timestamp},v1=${signature}`;
    expect(verifyWebhookSignature(secret, header, body, 5 * 60_000, timestamp + 1_000).valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const signature = signWebhookPayload(secret, timestamp, body);
    const header = `t=${timestamp},v1=${signature}`;
    expect(verifyWebhookSignature(secret, header, `${body} `, 5 * 60_000, timestamp + 1_000).valid).toBe(false);
  });

  it('rejects a signature outside the tolerance window', () => {
    const signature = signWebhookPayload(secret, timestamp, body);
    const header = `t=${timestamp},v1=${signature}`;
    const result = verifyWebhookSignature(secret, header, body, 5 * 60_000, timestamp + 10 * 60_000);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('tolerance');
  });

  it('rejects a wrong secret', () => {
    const signature = signWebhookPayload('another_secret', timestamp, body);
    const header = `t=${timestamp},v1=${signature}`;
    expect(verifyWebhookSignature(secret, header, body, 5 * 60_000, timestamp).valid).toBe(false);
  });

  it('parses the header', () => {
    const parsed = parseSignatureHeader('t=123,v1=abc');
    expect(parsed).toEqual({ timestamp: 123, signatures: ['abc'] });
    expect(parseSignatureHeader('nonsense')).toBeNull();
  });

  it('hashes the secret so the plaintext is not stored', () => {
    const hash = hashWebhookSecret(secret);
    expect(hash).not.toContain(secret);
    expect(hash).toHaveLength(64);
  });

  it('generates a high entropy secret', () => {
    const generated = generateWebhookSecret();
    expect(generated.startsWith('whsec_')).toBe(true);
    expect(generated.length).toBeGreaterThan(30);
    expect(generated).not.toBe(generateWebhookSecret());
  });
});

describe('SSRF protection', () => {
  it('blocks private and internal addresses', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('2606:4700::1111')).toBe(false);
  });

  it('blocks internal hostnames', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('api.internal')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
  });

  it('rejects a private destination', () => {
    const result = validateHttpDestination('http://127.0.0.1:8080/admin');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('private');
  });

  it('rejects the cloud metadata endpoint', () => {
    const result = validateHttpDestination('http://169.254.169.254/latest/meta-data/');
    expect(result.ok).toBe(false);
  });

  it('rejects a non http protocol', () => {
    expect(validateHttpDestination('file:///etc/passwd').ok).toBe(false);
    expect(validateHttpDestination('gopher://example.com').ok).toBe(false);
  });

  it('rejects a malformed url', () => {
    expect(validateHttpDestination('not a url').ok).toBe(false);
  });

  it('allows a public destination', () => {
    const result = validateHttpDestination('https://api.example.com/hook');
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe('api.example.com');
  });

  it('allows a private destination only when it is explicitly allowed', () => {
    expect(validateHttpDestination('http://10.0.0.5/hook', { allowPrivateNetwork: true }).ok).toBe(true);
  });

  it('re-checks the resolved address against DNS rebinding', () => {
    expect(validateResolvedAddress('93.184.216.34').ok).toBe(true);
    expect(validateResolvedAddress('169.254.169.254').ok).toBe(false);
    expect(validateResolvedAddress('not-an-ip').ok).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts sensitive keys', () => {
    const redacted = redactValue({
      password: 'hunter2',
      apiKey: 'abc',
      nested: { token: 'xyz', safe: 'value' },
    });
    expect(redacted).toEqual({
      password: '[redacted]',
      apiKey: '[redacted]',
      nested: { token: '[redacted]', safe: 'value' },
    });
  });

  it('masks emails and tokens in free text', () => {
    const summary = sanitizeErrorSummary('failed to send to ada@example.com with sk-abcdefgh12345678');
    expect(summary).not.toContain('ada@example.com');
    expect(summary).not.toContain('sk-abcdefgh12345678');
  });

  it('truncates long messages', () => {
    expect(sanitizeErrorSummary('x'.repeat(1000)).length).toBeLessThanOrEqual(500);
  });
});
