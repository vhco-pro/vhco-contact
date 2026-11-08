export interface Enquiry {
  submissionId: string;
  name: string;
  email: string;
  topic: string;
  message: string;
  turnstileToken: string;
}

export class RequestFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const FIELDS = new Set(['submissionId', 'name', 'email', 'topic', 'message', 'turnstileToken']);
const TOPICS = new Set(['', 'Platform engineering', 'Software development', 'Something else']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Match the browser's single-address email input syntax.
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const MAX_BODY_BYTES = 32 * 1024;

export function validEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

function field(value: unknown, maxLength: number, required = true): string {
  if (typeof value !== 'string' || value.length > maxLength || (required && !value.trim())) {
    throw new RequestFailure(422, 'invalid_request');
  }
  return value.trim();
}

async function readBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new RequestFailure(415, 'json_required');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new RequestFailure(413, 'body_too_large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestFailure(400, 'invalid_json');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk: ReadableStreamReadResult<unknown> = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new RequestFailure(400, 'invalid_json');
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new RequestFailure(413, 'body_too_large');
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof RequestFailure) throw error;
    throw new RequestFailure(400, 'invalid_json');
  } finally {
    reader.releaseLock();
  }
}

export async function readEnquiry(request: Request): Promise<Enquiry> {
  const input = await readBody(request);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestFailure(422, 'invalid_request');
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(input));
  if (Object.keys(fields).some(key => !FIELDS.has(key))) throw new RequestFailure(422, 'invalid_request');
  const submissionId = field(fields.submissionId, 36);
  const name = field(fields.name, 120);
  const email = field(fields.email, 254);
  const topic = field(fields.topic ?? '', 40, false);
  const message = field(fields.message, 5000);
  const turnstileToken = field(fields.turnstileToken, 2048, false);
  if (!UUID.test(submissionId) || !validEmail(email) || !TOPICS.has(topic) || /[\r\n\x00]/.test(name)) {
    throw new RequestFailure(422, 'invalid_request');
  }
  return { submissionId: submissionId.toLowerCase(), name, email, topic, message, turnstileToken };
}

export function json(status: number, code: string, headers: Record<string, string> = {}): Response {
  return Response.json({ status: code }, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...headers },
  });
}
