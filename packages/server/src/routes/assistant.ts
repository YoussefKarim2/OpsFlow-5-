/**
 * Ask OpsFlow over HTTP.
 *
 *   GET  /api/assistant/status  →  { enabled }   whether to show the button
 *   POST /api/assistant/ask     →  { answer, orders }
 *
 * Both need `order:read`: the assistant answers questions about orders, and a
 * person who cannot read orders has nothing to ask it. Everything finer than
 * that (costing, materials, quality…) is decided per section in tools.ts.
 *
 * `ask` is a POST because questions are long and private, not because it
 * changes anything — it never writes, so no change event or notification can
 * come from it. It is rate-limited per person: every question is a paid call
 * to the AI provider.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { AppError } from '../errors.js';
import { ask, DailyLimiter } from '../services/assistant/assistant.js';
import { configuredProvider, ProviderError, type AssistantProvider } from '../services/assistant/providers.js';
import { prismaOrderSource, type OrderSource } from '../services/assistant/facts.js';
import { askSchema } from '../services/assistant/schema.js';

export { askSchema };

/** Longer than any sensible answer takes; shorter than the proxies' own timeouts. */
export const QUESTION_DEADLINE_MS = 60_000;

export interface AssistantRouterDeps {
  provider?: () => AssistantProvider | null;
  source?: OrderSource;
  limiter?: DailyLimiter;
}

export function createAssistantRouter(deps: AssistantRouterDeps = {}): Router {
  const providerFor = deps.provider ?? (() => configuredProvider());
  const source = deps.source ?? prismaOrderSource;
  const daily = deps.limiter ?? new DailyLimiter(() => config.ASSISTANT_DAILY_LIMIT_PER_USER);

  const router = Router();
  router.use(authenticate);

  // Bursts: a person typing fast is fine; a script is not.
  const burst = rateLimit({
    windowMs: 60_000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    // The router authenticates first, so there is always a user to key on.
    keyGenerator: (req) => `assistant:${req.user!.id}`,
    message: { error: 'You are asking very quickly. Wait a minute and try again.', code: 'RATE_LIMITED' },
  });

  router.get('/status', requirePermission('order:read'), (_req, res) => {
    res.json({ enabled: providerFor() !== null });
  });

  router.post('/ask', requirePermission('order:read'), burst, asyncHandler(async (req, res) => {
    const provider = providerFor();
    if (!provider) throw new AppError('Ask OpsFlow is not switched on for this installation.', 503, 'ASSISTANT_DISABLED');
    const body = askSchema.parse(req.body);
    const user = currentUser(req);
    if (!daily.take(user.id)) {
      throw new AppError('You have reached today\'s limit of questions. You can ask again tomorrow.', 429, 'ASSISTANT_DAILY_LIMIT');
    }
    // One deadline for the whole question, however many lookups it takes, and
    // stop paying for an answer nobody is waiting for any more.
    const stop = new AbortController();
    const deadline = setTimeout(() => stop.abort(), QUESTION_DEADLINE_MS);
    const onClose = () => { if (!res.writableEnded) stop.abort(); };
    res.on('close', onClose);
    try {
      const result = await ask(
        { messages: body.messages, user: { name: user.name, roleKey: user.roleKey, permissions: user.permissions }, today: new Date() },
        provider,
        { source },
        stop.signal,
      );
      res.json({ answer: result.answer, orders: result.orders });
    } catch (e) {
      if (res.writableEnded || req.socket.destroyed) return;
      if (e instanceof ProviderError) {
        // The provider's message can name the model or quota; the person
        // gets a plain sentence, the log gets the detail (never the key).
        console.warn(`[assistant] ${provider.name}/${provider.model}: ${e.message}`);
        throw new AppError('Ask OpsFlow could not answer right now. Please try again in a moment.', 502, 'ASSISTANT_UNAVAILABLE');
      }
      throw e;
    } finally {
      clearTimeout(deadline);
      res.off('close', onClose);
    }
  }));

  return router;
}

export const assistantRouter = createAssistantRouter();
