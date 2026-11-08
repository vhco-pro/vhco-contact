import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, testEnvironment } from './fixtures';

describe('atomic submission reservations', () => {
  it('reuses one reservation for parallel identical IDs', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    const responses = await Promise.all(Array.from({ length: 8 }, () => worker.fetch(contactRequest(input), bindings)));
    expect(responses.every(response => [200, 202].includes(response.status))).toBe(true);
    expect([200, 202]).toContain((await worker.fetch(contactRequest(), bindings)).status);
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(429);
  });

  it('recovers an existing ID without another challenge or quota charge', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    const first = await worker.fetch(contactRequest(input), bindings);
    expect([200, 202]).toContain(first.status);
    bindings.verify.mockClear();
    const retry = await worker.fetch(contactRequest({ ...input, turnstileToken: '' }), bindings);
    expect([200, 202]).toContain(retry.status);
    expect(bindings.verify).not.toHaveBeenCalled();
    expect([200, 202]).toContain((await worker.fetch(contactRequest(), bindings)).status);
  });

  it('rejects an ID reused with a different message', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    await worker.fetch(contactRequest(input), bindings);
    bindings.verify.mockClear();
    const conflict = await worker.fetch(contactRequest({ ...input, message: 'Different enquiry' }), bindings);
    expect(conflict.status).toBe(409);
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('fails closed before challenge and sending when storage is unavailable', async () => {
    const bindings = testEnvironment();
    vi.spyOn(bindings.SUBMISSIONS, 'get').mockImplementation(() => { throw new Error('Fixture storage outage'); });
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(503);
    expect(bindings.verify).not.toHaveBeenCalled();
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });
});
