import type { Env } from './index';
import type { Enquiry } from './request';

export type DeliveryOutcome = 'accepted' | 'failed' | 'uncertain';
const KNOWN_REJECTIONS = new Set(['E_SENDER_NOT_VERIFIED', 'E_RATE_LIMIT_EXCEEDED']);

export async function sendEnquiry(input: Enquiry, env: Env): Promise<DeliveryOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Provider deadline exceeded')), 10_000);
  });
  try {
    const subject = env.SITE_PROFILE === 'stackweaver' ? 'Stackweaver enquiry' : 'Website enquiry';
    const result: unknown = await Promise.race([
      env.EMAIL.send({
        to: 'Michiel@vhco.pro',
        from: env.SENDER_EMAIL,
        replyTo: input.email,
        subject: input.topic ? `${subject} - ${input.topic}` : subject,
        text: `From: ${input.name} <${input.email}>\nTopic: ${input.topic || 'Unspecified'}\n\n${input.message}`,
      }),
      deadline,
    ]);
    if (result !== null && typeof result === 'object' && 'messageId' in result
      && typeof result.messageId === 'string' && result.messageId.length > 0) return 'accepted';
    return 'uncertain';
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string'
      && KNOWN_REJECTIONS.has(error.code)) return 'failed';
    return 'uncertain';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
