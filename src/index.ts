import { json, readEnquiry, RequestFailure, validEmail } from './request';
import { verifyChallenge } from './challenge';
import { SubmissionStore, type Reservation } from './submissions';
import type { Enquiry } from './request';
import { sendEnquiry } from './delivery';

export { SubmissionStore };

export interface Env {
  SITE_ORIGIN: string;
  SITE_PROFILE: string;
  EMAIL: SendEmail;
  SUBMISSIONS: DurableObjectNamespace<SubmissionStore>;
  HMAC_SECRET: string;
  TURNSTILE_SECRET: string;
  SENDER_EMAIL: string;
}

function normalizeAddress(value: string | null): string {
  if (!value) throw new RequestFailure(403, 'client_address_required');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.').map(Number);
    if (parts.every(part => part <= 255)) return parts.join('.');
  }
  if (!value.includes(':') || /[^0-9a-f:.]/i.test(value)) throw new RequestFailure(403, 'invalid_client_address');
  try {
    const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(address);
    if (mapped?.[1] && mapped[2]) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    return address;
  } catch {
    throw new RequestFailure(403, 'invalid_client_address');
  }
}

async function submissionKeys(input: Enquiry, address: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  async function sign(value: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const payload = JSON.stringify({ name: input.name, email: input.email, topic: input.topic, message: input.message });
  const [ipHash, payloadHash] = await Promise.all([sign(`ip\0${address}`), sign(`payload\0${payload}`)]);
  return { ipHash, payloadHash };
}

function reservationResponse(result: Reservation): Response {
  if (result.state === 'limited') return json(429, 'rate_limited', { 'Retry-After': String(result.retryAfter) });
  if (result.state === 'conflict') return json(409, 'submission_conflict');
  if (result.state === 'accepted') return json(200, 'accepted');
  if (result.state === 'failed') return json(503, 'unavailable');
  if (result.state === 'uncertain') return json(202, 'uncertain');
  return json(202, 'pending');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const site = new URL(env.SITE_ORIGIN);
      if (url.hostname !== site.hostname || url.port !== site.port) return json(403, 'origin_rejected');
      // Cloudflare wildcards can also match adjacent paths.
      if (env.SITE_PROFILE === 'stackweaver') {
        if (url.pathname !== '/api/contact') return fetch(request);
        if (url.search) return json(404, 'not_found');
      } else if (env.SITE_PROFILE === 'vitepress') {
        if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return fetch(request);
        if (url.pathname !== '/api/contact') return json(404, 'not_found');
      } else {
        return json(503, 'unavailable');
      }
      if (url.origin !== site.origin) return json(403, 'origin_rejected');
      if (request.method !== 'POST') return json(405, 'method_not_allowed', { Allow: 'POST' });
      if (request.headers.get('Origin') !== site.origin) return json(403, 'origin_rejected');
      if (!env.TURNSTILE_SECRET || env.HMAC_SECRET?.length < 32
        || !env.HMAC_SECRET || !env.SENDER_EMAIL || !validEmail(env.SENDER_EMAIL)
        || !env.EMAIL || typeof env.EMAIL.send !== 'function' || !env.SUBMISSIONS) {
        return json(503, 'unavailable');
      }
      const input = await readEnquiry(request);
      const address = normalizeAddress(request.headers.get('CF-Connecting-IP'));
      const keys = await submissionKeys(input, address, env.HMAC_SECRET);
      const store = env.SUBMISSIONS.get(env.SUBMISSIONS.idFromName('contact'));
      const existing = await store.lookup(input.submissionId, keys.payloadHash);
      if (existing.state !== 'missing') return reservationResponse(existing);
      await verifyChallenge(input, env.TURNSTILE_SECRET, site.hostname);
      const result = await store.reserve(input.submissionId, keys.payloadHash, keys.ipHash);
      if (result.state !== 'reserved') return reservationResponse(result);
      const outcome = await sendEnquiry(input, env);
      try {
        const saved = await store.complete(input.submissionId, keys.payloadHash, result.createdAt, outcome);
        if (!saved) return json(202, 'uncertain');
      } catch {
        return json(202, 'uncertain');
      }
      return reservationResponse({ state: outcome });
    } catch (error) {
      if (error instanceof RequestFailure) return json(error.status, error.code);
      return json(503, 'unavailable');
    }
  },
} satisfies ExportedHandler<Env>;
