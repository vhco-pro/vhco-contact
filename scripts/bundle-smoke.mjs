import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

const [input, configPath] = process.argv.slice(2);
if (!input || !configPath) throw new Error('Pass the verified module and its target config');
const bundle = resolve(input);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const otherName = config.vars.SITE_PROFILE === 'vitepress' ? 'stackweaver' : 'vitepress';
const other = JSON.parse(await readFile(new URL(`../${otherName}.wrangler.json`, import.meta.url), 'utf8'));
const messages = new Map();

function fixture(target) {
  const host = new URL(target.vars.SITE_ORIGIN).hostname;
  return {
    name: target.name,
    routes: target === config ? [host + '/*', 'wrong.example/*'] : [host + '/*'],
    modules: true,
    modulesRoot: dirname(bundle),
    scriptPath: bundle,
    compatibilityDate: target.compatibility_date,
    bindings: {
      ...target.vars,
      HMAC_SECRET: 'synthetic-key-long-enough-for-local-testing',
      TURNSTILE_SECRET: 'synthetic-turnstile-secret',
      SENDER_EMAIL: 'sender@example.invalid',
    },
    durableObjects: { SUBMISSIONS: { className: 'SubmissionStore', useSQLite: true } },
    serviceBindings: { EMAIL: { name: `${target.name}-mail`, entrypoint: 'Mailbox' } },
    outboundService: async request => {
      if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
        return Response.json({ success: true, hostname: host, action: 'contact' });
      }
      if (new URL(request.url).hostname !== host) throw new Error('Unexpected outbound host');
      return new Response('synthetic origin');
    },
  };
}

function mail(target) {
  return {
    name: `${target.name}-mail`,
    modules: true,
    compatibilityDate: target.compatibility_date,
    script: `
      import { WorkerEntrypoint } from 'cloudflare:workers';
      export class Mailbox extends WorkerEntrypoint {
        async send(message) {
          await this.env.RECORDER.fetch('https://fixture.invalid/', {
            method: 'POST', body: JSON.stringify(message)
          });
          return { messageId: 'synthetic-message' };
        }
      }
      export default { fetch() { return new Response(null, { status: 404 }); } };
    `,
    serviceBindings: {
      RECORDER: async request => {
        const deliveries = messages.get(target.name) ?? [];
        deliveries.push(await request.json());
        messages.set(target.name, deliveries);
        return new Response(null, { status: 204 });
      },
    },
  };
}

const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1',
  port: 0,
  workers: [fixture(config), fixture(other), mail(config), mail(other)],
}));
try {
  const payload = {
    submissionId: crypto.randomUUID(), name: 'Synthetic Visitor', email: 'visitor@example.invalid',
    topic: '', message: 'Local verified-bundle check.', turnstileToken: 'synthetic',
  };
  function submit(target, body = payload, origin = target.vars.SITE_ORIGIN) {
    return runtime.dispatchFetch(`${origin}/api/contact`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' },
      body: JSON.stringify(body),
    });
  }
  const first = await submit(config);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.equal(first.headers.get('X-Robots-Tag'), 'noindex');
  assert.deepEqual(await first.json(), { status: 'accepted' });
  assert.equal((await submit(config)).status, 200);
  assert.equal((await submit(config, { ...payload, submissionId: crypto.randomUUID() })).status, 200);
  assert.equal((await submit(config, { ...payload, submissionId: crypto.randomUUID() })).status, 429);
  assert.equal((await submit(config, payload, 'https://wrong.example')).status, 403);
  assert.equal((await submit(other)).status, 200);
  assert.equal((await submit(other)).status, 200);
  for (const target of [config, other]) {
    const stackweaver = target.vars.SITE_PROFILE === 'stackweaver';
    const origin = target.vars.SITE_ORIGIN;
    const delivery = messages.get(target.name);
    assert.equal(delivery.length, target === config ? 2 : 1);
    assert.equal(delivery[0].subject, stackweaver ? 'Stackweaver enquiry' : 'Website enquiry');
    assert.equal(delivery[0].replyTo, payload.email);
    assert.equal((await runtime.dispatchFetch(origin + '/api/contact')).status, 405);
    assert.equal((await runtime.dispatchFetch(origin + '/api/contact?probe=1')).status, stackweaver ? 404 : 405);
    const neighbour = await runtime.dispatchFetch(origin + '/api/contact-example');
    assert.equal(neighbour.status, stackweaver ? 200 : 404);
    if (stackweaver) assert.equal(await neighbour.text(), 'synthetic origin');
  }
  console.log('Verified bundle passes both isolated workerd target contracts');
} finally {
  await runtime.dispose();
}
