import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, testEnvironment } from './fixtures';

describe('server-side challenge verification', () => {
  it.each([
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: false, 'error-codes': ['invalid-input-response'] },
    { success: true, hostname: 'other.example', action: 'contact' },
    { success: true, hostname: 'vhco.pro', action: 'login' },
    { success: 'true', hostname: 'vhco.pro', action: 'contact' },
    null,
  ])('rejects invalid verification reply %j', async (reply) => {
    const bindings = testEnvironment();
    bindings.verify.mockResolvedValueOnce(Response.json(reply));
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(403);
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it.each([500, 429])('fails closed on Siteverify HTTP %i', async (status) => {
    const bindings = testEnvironment();
    bindings.verify.mockResolvedValueOnce(new Response('', { status }));
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(503);
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it('fails closed on timeout', async () => {
    const bindings = testEnvironment();
    bindings.verify.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(503);
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed provider response', async () => {
    const bindings = testEnvironment();
    bindings.verify.mockResolvedValueOnce(new Response('not json'));
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(503);
  });

  it('submits only the token and server credentials to the fixed verifier', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    await worker.fetch(contactRequest(input), bindings);
    expect(bindings.verify).toHaveBeenCalledOnce();
    const call = bindings.verify.mock.calls[0];
    expect(call?.[0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(call?.[1]?.method).toBe('POST');
    const body = call?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (!(body instanceof URLSearchParams)) throw new Error('Expected encoded challenge fields');
    expect(body.toString()).not.toContain('visitor');
    expect(body.toString()).not.toContain('192.0.2');
  });
});
