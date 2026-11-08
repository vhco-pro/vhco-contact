import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, testEnvironment } from './fixtures';

describe('request boundary', () => {
  const invalidFields: [string, Record<string, unknown>][] = [
    ['blank name', { name: '   ' }],
    ['long name', { name: 'n'.repeat(121) }],
    ['non-string name', { name: 42 }],
    ['blank message', { message: '\n ' }],
    ['long message', { message: 'm'.repeat(5001) }],
    ['non-string message', { message: [] }],
    ['malformed email', { email: 'visitor@' }],
    ['long email', { email: `${'a'.repeat(250)}@x.com` }],
    ['header injection', { email: 'visitor@example.com\r\nBcc: other@example.com' }],
    ['email list', { email: 'one@example.com,two@example.com' }],
    ['unknown topic', { topic: 'Send me marketing' }],
    ['non-string token', { turnstileToken: true }],
    ['long token', { turnstileToken: 't'.repeat(2049) }],
    ['invalid submission ID', { submissionId: 'not-a-uuid' }],
    ['extra recipient', { to: 'other@example.com' }],
    ['extra IP', { ip: '192.0.2.20' }],
  ];

  it.each(invalidFields)('rejects %s before external calls', async (_name, fields) => {
    const bindings = testEnvironment();
    const response = await worker.fetch(contactRequest(enquiry(fields)), bindings);
    expect(response.status).toBe(422);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(bindings.verify).not.toHaveBeenCalled();
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it.each([null, [], 'text'])('rejects non-object input %j', async (input) => {
    const bindings = testEnvironment();
    expect((await worker.fetch(contactRequest(input), bindings)).status).toBe(422);
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const bindings = testEnvironment();
    expect((await worker.fetch(contactRequest(null, { body: '{' }), bindings)).status).toBe(400);
  });

  it('bounds a streaming body even without Content-Length', async () => {
    const bindings = testEnvironment();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(' '.repeat(32 * 1024 + 1)));
        controller.close();
      },
    });
    expect((await worker.fetch(contactRequest(null, { body }), bindings)).status).toBe(413);
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('rejects non-JSON content', async () => {
    const bindings = testEnvironment();
    const request = contactRequest();
    request.headers.set('Content-Type', 'text/plain');
    expect((await worker.fetch(request, bindings)).status).toBe(415);
  });

  it.each(['https://attacker.example', 'null', ''])('rejects origin %j', async (origin) => {
    const bindings = testEnvironment();
    const request = contactRequest();
    request.headers.set('Origin', origin);
    expect((await worker.fetch(request, bindings)).status).toBe(403);
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured hostname', async () => {
    const bindings = testEnvironment();
    const request = new Request('https://another.workers.dev/api/contact', contactRequest());
    expect((await worker.fetch(request, bindings)).status).toBe(403);
  });

  it('returns JSON 404 for an unknown API path', async () => {
    const bindings = testEnvironment();
    const request = new Request('https://vhco.pro/api/missing', contactRequest());
    const response = await worker.fetch(request, bindings);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('allows POST only', async () => {
    const bindings = testEnvironment();
    const response = await worker.fetch(new Request('https://vhco.pro/api/contact'), bindings);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('fails closed without server configuration', async () => {
    const bindings = testEnvironment();
    bindings.TURNSTILE_SECRET = '';
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(503);
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('passes a bounded valid enquiry to challenge verification', async () => {
    const bindings = testEnvironment();
    await worker.fetch(contactRequest(enquiry({ name: 'n'.repeat(120), message: 'm'.repeat(5000), topic: '' })), bindings);
    expect(bindings.verify).toHaveBeenCalledOnce();
  });
});
