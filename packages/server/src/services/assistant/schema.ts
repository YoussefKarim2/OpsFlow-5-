import { z } from 'zod';

const turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });

/**
 * What the browser may send to /api/assistant/ask. Recent turns only: older
 * ones cost money and add nothing.
 *
 * Earlier answers are the assistant's own words coming back, so an over-long
 * one is shortened rather than refused — refusing it would leave the person
 * stuck, unable to ask anything until they cleared the conversation. A history
 * that starts with an answer (the browser keeps the last N turns) has that
 * answer dropped, since a conversation starts with a question.
 */
export const askSchema = z.preprocess(
  (body) => {
    if (!body || typeof body !== 'object' || !Array.isArray((body as { messages?: unknown }).messages)) return body;
    const messages = ((body as { messages: unknown[] }).messages).map((m) => {
      const t = turn.safeParse(m);
      return t.success && t.data.role === 'assistant' ? { ...t.data, content: t.data.content.slice(0, 4000) } : m;
    });
    while (messages.length > 1 && turn.safeParse(messages[0]).data?.role === 'assistant') messages.shift();
    return { ...body, messages };
  },
  z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(4000),
    })).min(1).max(20),
  })
    // Zod runs these even when the array check above failed, so an empty list
    // must not be read as if it had a last element.
    .refine((b) => b.messages.at(-1)?.role === 'user', { message: 'The last message must be the question', path: ['messages'] })
    .refine((b) => (b.messages.at(-1)?.content.length ?? 0) <= 1500, { message: 'Questions are limited to 1,500 characters', path: ['messages'] }),
);
