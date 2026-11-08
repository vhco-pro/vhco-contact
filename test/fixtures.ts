import { afterEach, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';

// workerd's alarm scheduler uses real time even while the test stubs Date.
export const TEST_TIME = new Date(new Date().setUTCHours(36, 0, 0, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TEST_TIME);
});

afterEach(async () => {
  await reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export function enquiry(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: crypto.randomUUID(),
    name: 'Test Visitor',
    email: 'visitor@example.com',
    topic: 'Platform engineering',
    message: 'A synthetic enquiry for the contact tests.',
    turnstileToken: 'fixture-token',
    ...overrides,
  };
}

export function contactRequest(body: unknown = enquiry(), init: RequestInit = {}) {
  return new Request('https://vhco.pro/api/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://vhco.pro',
      'CF-Connecting-IP': '192.0.2.10',
    },
    body: JSON.stringify(body),
    ...init,
  });
}

export function testEnvironment() {
  const send = vi.fn<(message: EmailMessage | EmailMessageBuilder) => Promise<EmailSendResult>>()
    .mockResolvedValue({ messageId: 'fixture-message' });
  const verify = vi.fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ success: true, hostname: 'vhco.pro', action: 'contact' })));
  vi.stubGlobal('fetch', verify);
  return {
    ...env,
    HMAC_SECRET: 'test-only-hmac-key-not-for-production',
    TURNSTILE_SECRET: 'test-only-turnstile-secret',
    SENDER_EMAIL: 'website@vhco.pro',
    EMAIL: { send },
    verify,
  };
}
