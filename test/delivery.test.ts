import { evictAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, TEST_TIME, testEnvironment } from './fixtures';

describe('email delivery', () => {
  it('accepts only after sending a fixed-recipient plain-text enquiry', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    const response = await worker.fetch(contactRequest(input), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'accepted' });
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
    expect(bindings.EMAIL.send).toHaveBeenCalledWith({
      to: 'Michiel@vhco.pro',
      from: 'website@vhco.pro',
      replyTo: 'visitor@example.com',
      subject: 'Website enquiry - Platform engineering',
      text: 'From: Test Visitor <visitor@example.com>\nTopic: Platform engineering\n\nA synthetic enquiry for the contact tests.',
    });
  });

  it('recovers an accepted result after a lost client response', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    await worker.fetch(contactRequest(input), bindings);
    bindings.verify.mockClear();
    const retry = await worker.fetch(contactRequest({ ...input, turnstileToken: '' }), bindings);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: 'accepted' });
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('sends one email for simultaneous identical submissions', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    const responses = await Promise.all(Array.from({ length: 10 }, () => worker.fetch(contactRequest(input), bindings)));
    expect(responses.every(response => [200, 202].includes(response.status))).toBe(true);
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
  });

  it('records a known provider rejection without sending on retry', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    bindings.EMAIL.send.mockRejectedValueOnce(Object.assign(new Error('Synthetic sender rejection'), { code: 'E_SENDER_NOT_VERIFIED' }));
    expect((await worker.fetch(contactRequest(input), bindings)).status).toBe(503);
    expect((await worker.fetch(contactRequest(input), bindings)).status).toBe(503);
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(200);
    expect((await worker.fetch(contactRequest(), bindings)).status).toBe(429);
    expect(bindings.EMAIL.send).toHaveBeenCalledTimes(2);
  });

  it('retains uncertain outcomes instead of resending after a network error', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    bindings.EMAIL.send.mockRejectedValueOnce(new Error('Connection lost after sending'));
    const first = await worker.fetch(contactRequest(input), bindings);
    expect(await first.json()).toEqual({ status: 'uncertain' });
    bindings.verify.mockClear();
    const retry = await worker.fetch(contactRequest({ ...input, turnstileToken: '' }), bindings);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ status: 'uncertain' });
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
    expect(bindings.verify).not.toHaveBeenCalled();
  });

  it('does not report acceptance for a malformed provider acknowledgement', async () => {
    const bindings = testEnvironment();
    bindings.EMAIL.send.mockResolvedValueOnce({ messageId: '' });
    const response = await worker.fetch(contactRequest(), bindings);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'uncertain' });
  });

  it('times out a stalled provider without making another attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(TEST_TIME);
    const bindings = testEnvironment();
    const input = enquiry();
    bindings.EMAIL.send.mockImplementationOnce(() => new Promise(() => {}));
    const pending = worker.fetch(contactRequest(input), bindings);
    await vi.waitFor(() => expect(bindings.EMAIL.send).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_001);
    const response = await pending;
    expect(await response.json()).toEqual({ status: 'uncertain' });
    expect((await worker.fetch(contactRequest(input), bindings)).status).toBe(202);
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
  });

  it('preserves a pending reservation across object eviction during sending', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    let release: ((result: EmailSendResult) => void) | undefined;
    bindings.EMAIL.send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = worker.fetch(contactRequest(input), bindings);
    await vi.waitFor(() => expect(bindings.EMAIL.send).toHaveBeenCalledOnce());
    await evictAllDurableObjects();
    const retry = await worker.fetch(contactRequest({ ...input, turnstileToken: '' }), bindings);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ status: 'pending' });
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
    if (!release) throw new Error('Expected a pending synthetic provider call');
    release({ messageId: 'fixture-message' });
    expect((await first).status).toBe(200);
  });

  it('cannot let an old completion overwrite a new reservation after expiry', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    const releases: ((result: EmailSendResult) => void)[] = [];
    bindings.EMAIL.send.mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
    const oldAttempt = worker.fetch(contactRequest(input), bindings);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    vi.setSystemTime(TEST_TIME.getTime() + 25 * 60 * 60_000);
    const newAttempt = worker.fetch(contactRequest({ ...input, turnstileToken: 'fresh-token' }), bindings);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]?.({ messageId: 'late-old-result' });
    expect((await oldAttempt).status).toBe(202);
    const duringNewAttempt = await worker.fetch(contactRequest(input), bindings);
    expect(await duringNewAttempt.json()).toEqual({ status: 'pending' });
    releases[1]?.({ messageId: 'new-result' });
    expect((await newAttempt).status).toBe(200);
  });

  it('fails safely when the accepted result cannot be persisted', async () => {
    const bindings = testEnvironment();
    const input = enquiry();
    const stub = bindings.SUBMISSIONS.get(bindings.SUBMISSIONS.idFromName('contact'));
    const unavailableCompletion = new Proxy(stub, {
      get(target, property) {
        if (property === 'complete') return () => Promise.reject(new Error('Synthetic completion outage'));
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value === 'function') return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
        return value;
      },
    });
    vi.spyOn(bindings.SUBMISSIONS, 'get').mockReturnValue(unavailableCompletion);
    const first = await worker.fetch(contactRequest(input), bindings);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: 'uncertain' });
    expect((await worker.fetch(contactRequest(input), bindings)).status).toBe(202);
    expect(bindings.EMAIL.send).toHaveBeenCalledOnce();
  });
});
