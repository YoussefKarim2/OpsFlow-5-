/**
 * A user's own notification settings.
 *
 * Deliberately no `requirePermission` beyond being signed in — everyone
 * manages their own notifications, there is nothing here to gate by role.
 * `GET` always returns all ten categories, filling in the default
 * (in-app + email, every priority) for any category the user has never
 * touched, so the settings page never shows a blank row.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ChangeCategory, NotificationPriority, CATEGORY_LABEL } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';

export const notificationPreferencesRouter = Router();
notificationPreferencesRouter.use(authenticate);

const CATEGORIES = Object.values(ChangeCategory);

notificationPreferencesRouter.get('/', asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const rows = await prisma.notificationPreference.findMany({ where: { userId: actor.id } });
  const byCategory = new Map(rows.map((r) => [r.category, r]));

  res.json({
    data: CATEGORIES.map((category) => {
      const row = byCategory.get(category);
      return {
        category,
        label: CATEGORY_LABEL[category],
        inApp: row?.inApp ?? true,
        email: row?.email ?? true,
        minPriority: row?.minPriority ?? NotificationPriority.LOW,
      };
    }),
  });
}));

const preferenceSchema = z.object({
  category: z.enum(Object.values(ChangeCategory) as [string, ...string[]]),
  inApp: z.boolean(),
  email: z.boolean(),
  minPriority: z.enum(Object.values(NotificationPriority) as [string, ...string[]]),
});

notificationPreferencesRouter.put('/', asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = z.array(preferenceSchema).parse(req.body);

  await prisma.$transaction(
    input.map((p) =>
      prisma.notificationPreference.upsert({
        where: { userId_category: { userId: actor.id, category: p.category as never } },
        create: {
          userId: actor.id, category: p.category as never,
          inApp: p.inApp, email: p.email, minPriority: p.minPriority as never,
        },
        update: { inApp: p.inApp, email: p.email, minPriority: p.minPriority as never },
      }),
    ),
  );

  res.json({ ok: true });
}));
