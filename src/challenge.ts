import { RequestFailure, type Enquiry } from './request';

export async function verifyChallenge(input: Enquiry, secret: string, hostname: string): Promise<void> {
  if (!input.turnstileToken) throw new RequestFailure(403, 'challenge_invalid');
  let result: unknown;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({
        secret,
        response: input.turnstileToken,
        idempotency_key: input.submissionId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Verification unavailable');
    result = await response.json();
  } catch {
    throw new RequestFailure(503, 'verification_unavailable');
  }
  if (result === null || typeof result !== 'object'
    || !('success' in result) || result.success !== true
    || !('hostname' in result) || result.hostname !== hostname
    || !('action' in result) || result.action !== 'contact') {
    throw new RequestFailure(403, 'challenge_invalid');
  }
}
