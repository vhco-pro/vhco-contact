import { expect, it } from 'vitest';
import worker from '../src/index';
import { contactRequest, enquiry, testEnvironment } from './fixtures';

it('delivers Stackweaver enquiries with a distinct subject and the visitor Reply-To', async () => {
  const origin = 'https://stackweaver.sh';
  const bindings = { ...testEnvironment(), SITE_ORIGIN: origin, SITE_PROFILE: 'stackweaver' };
  bindings.verify.mockResolvedValue(Response.json({ success: true, hostname: 'stackweaver.sh', action: 'contact' }));
  const request = new Request(origin + '/api/contact', contactRequest(enquiry(), {
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' },
  }));
  const response = await worker.fetch(request, bindings);
  expect(response.status).toBe(200);
  expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
  expect(bindings.EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({
    subject: 'Stackweaver enquiry - Platform engineering',
    replyTo: 'visitor@example.com',
  }));
});

it('forwards neighbouring Stackweaver API requests and rejects query variants of contact', async () => {
  const origin = 'https://stackweaver.sh';
  const bindings = { ...testEnvironment(), SITE_ORIGIN: origin, SITE_PROFILE: 'stackweaver' };
  bindings.verify.mockResolvedValue(new Response('existing origin'));
  const neighbour = new Request(origin + '/api/contact-example');
  expect(await (await worker.fetch(neighbour, bindings)).text()).toBe('existing origin');
  expect(bindings.verify).toHaveBeenCalledWith(neighbour);
  const query = new Request(origin + '/api/contact?probe=true');
  expect((await worker.fetch(query, bindings)).status).toBe(404);
  expect(bindings.EMAIL.send).not.toHaveBeenCalled();
});
