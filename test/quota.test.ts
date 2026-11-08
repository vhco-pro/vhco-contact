import { evictAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, TEST_TIME, testEnvironment } from './fixtures';

describe('persistent quotas', () => {
  async function submit(bindings: ReturnType<typeof testEnvironment>, ip = '192.0.2.10') {
    const request = contactRequest();
    request.headers.set('CF-Connecting-IP', ip);
    return worker.fetch(request, bindings);
  }

  it('allows two attempts and returns the rolling wait time for the third', async () => {
    const bindings = testEnvironment();
    expect([200, 202]).toContain((await submit(bindings)).status);
    expect([200, 202]).toContain((await submit(bindings)).status);
    const response = await submit(bindings);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
  });

  it('expires each attempt at its rolling boundary', async () => {
    const bindings = testEnvironment();
    await submit(bindings);
    vi.setSystemTime(TEST_TIME.getTime() + 30 * 60_000);
    await submit(bindings);
    vi.setSystemTime(TEST_TIME.getTime() + 60 * 60_000);
    expect([200, 202]).toContain((await submit(bindings)).status);
    const response = await submit(bindings);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1800');
  });

  it('reserves only two slots for twelve concurrent requests', async () => {
    const bindings = testEnvironment();
    const responses = await Promise.all(Array.from({ length: 12 }, () => submit(bindings)));
    expect(responses.filter(response => [200, 202].includes(response.status))).toHaveLength(2);
    expect(responses.filter(response => response.status === 429)).toHaveLength(10);
  });

  it('enforces the shared daily cap across separate IPs', async () => {
    const bindings = testEnvironment();
    const responses = await Promise.all(Array.from({ length: 26 }, (_, i) => submit(bindings, `192.0.2.${i + 1}`)));
    expect(responses.filter(response => [200, 202].includes(response.status))).toHaveLength(25);
    const blocked = responses.find(response => response.status === 429);
    expect(blocked?.headers.get('Retry-After')).toBe('43200');
  });

  it('resets the site cap at midnight UTC', async () => {
    const bindings = testEnvironment();
    vi.setSystemTime('2026-11-06T23:59:00Z');
    for (let i = 1; i <= 25; i++) await submit(bindings, `192.0.2.${i}`);
    const blocked = await submit(bindings, '192.0.2.26');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('60');
    vi.setSystemTime('2026-11-07T00:00:00Z');
    expect([200, 202]).toContain((await submit(bindings, '192.0.2.26')).status);
  });

  it('preserves the allowance across object eviction', async () => {
    const bindings = testEnvironment();
    await submit(bindings);
    await submit(bindings);
    await evictAllDurableObjects();
    expect((await submit(bindings)).status).toBe(429);
  });

  it.each([
    ['2001:db8::1', '2001:0db8:0:0:0:0:0:1'],
    ['192.0.2.10', '::ffff:192.0.2.10'],
  ])('normalizes equivalent addresses %s and %s', async (first, second) => {
    const bindings = testEnvironment();
    await submit(bindings, first);
    await submit(bindings, second);
    expect((await submit(bindings, first)).status).toBe(429);
  });

  it.each(['', 'not-an-ip', '999.0.2.10', '2001:db8::1%eth0'])('rejects unusable edge IP %j', async (ip) => {
    const bindings = testEnvironment();
    const response = await submit(bindings, ip);
    expect(response.status).toBe(403);
    expect(bindings.verify).not.toHaveBeenCalled();
    expect(bindings.EMAIL.send).not.toHaveBeenCalled();
  });

  it('ignores an untrusted forwarding header when the edge address is missing', async () => {
    const bindings = testEnvironment();
    const request = contactRequest(enquiry());
    request.headers.delete('CF-Connecting-IP');
    request.headers.set('X-Forwarded-For', '192.0.2.99');
    expect((await worker.fetch(request, bindings)).status).toBe(403);
  });
});
