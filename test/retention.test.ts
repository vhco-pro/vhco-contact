import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, TEST_TIME, testEnvironment } from './fixtures';

describe('operational privacy and expiry', () => {
  function store(bindings: ReturnType<typeof testEnvironment>) {
    return bindings.SUBMISSIONS.get(bindings.SUBMISSIONS.idFromName('contact'));
  }

  it('stores only opaque keys and operational metadata', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    await worker.fetch(contactRequest(input), bindings);
    const rows = await runInDurableObject(store(bindings), (_instance, state) => state.storage.sql.exec('SELECT * FROM submissions').toArray());
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['created_at', 'id', 'ip_hash', 'payload_hash', 'state']);
    expect(rows[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    const challenges = await runInDurableObject(store(bindings), (_instance, state) =>
      state.storage.sql.exec('SELECT * FROM consumed_challenges').toArray());
    expect(challenges).toHaveLength(1);
    expect(challenges[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenges[0]?.created_at).toBe(TEST_TIME.getTime());
    const saved = JSON.stringify({ rows, challenges });
    for (const value of ['192.0.2.10', input.name, input.email, input.message, input.turnstileToken, bindings.HMAC_SECRET]) {
      expect(saved).not.toContain(value);
    }
  });

  it('removes expired records while the form is idle', async () => {
    const bindings = testEnvironment();
    await worker.fetch(contactRequest(), bindings);
    const stub = store(bindings);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(TEST_TIME.getTime() + 24 * 60 * 60_000);
    vi.setSystemTime(TEST_TIME.getTime() + 24 * 60 * 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const count = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM submissions').one().total);
    expect(count).toBe(0);
    const challenges = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec('SELECT token_hash FROM consumed_challenges').toArray());
    expect(challenges).toEqual([]);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('keeps newer records and schedules their own expiry without delaying the oldest alarm', async () => {
    const bindings = testEnvironment();
    await worker.fetch(contactRequest(), bindings);
    const stub = store(bindings);
    vi.setSystemTime(TEST_TIME.getTime() + 12 * 60 * 60_000);
    await worker.fetch(contactRequest(), bindings);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(TEST_TIME.getTime() + 24 * 60 * 60_000);
    vi.setSystemTime(TEST_TIME.getTime() + 24 * 60 * 60_000);
    await runDurableObjectAlarm(stub);
    const count = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM submissions').one().total);
    expect(count).toBe(1);
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(TEST_TIME.getTime() + 36 * 60 * 60_000);
  });

  it('bounds deduplication to the selected retention window', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    expect((await worker.fetch(contactRequest(input), bindings)).status).toBe(200);
    vi.setSystemTime(TEST_TIME.getTime() + 24 * 60 * 60_000);
    expect((await worker.fetch(contactRequest({ ...input, turnstileToken: 'fresh-token' }), bindings)).status).toBe(200);
    expect(bindings.EMAIL.send).toHaveBeenCalledTimes(2);
  });

  it('does not expose private data in responses or application logs on provider failure', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const bindings = testEnvironment();
    const input = enquiry();
    bindings.EMAIL.send.mockRejectedValueOnce(new Error(`Synthetic error with ${input.email} ${input.message}`));
    const response = await worker.fetch(contactRequest(input), bindings);
    expect(await response.json()).toEqual({ status: 'uncertain' });
    const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
    for (const value of [input.email, input.message, '192.0.2.10', bindings.HMAC_SECRET, bindings.TURNSTILE_SECRET]) {
      expect(output).not.toContain(value);
    }
  });
});
