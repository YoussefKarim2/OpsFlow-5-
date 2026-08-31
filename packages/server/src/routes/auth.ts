import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { normaliseEmail, computeLockout } from '@opsflow/shared';
import { prisma } from '../db.js';
import { config, isAllowlistedSuperAdmin } from '../config.js';
import { signToken, authenticate, currentUser } from '../middleware/auth.js';
import { UnauthorizedError, ValidationError } from '../errors.js';
import { asyncHandler } from '../util/async-handler.js';
import { requestContextMiddleware } from '../request-context.js';
import { logActivity } from '../services/activity-service.js';

export const authRouter = Router();

// Brute-force protection on the only unauthenticated write endpoint.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const address = normaliseEmail(email);

  const user = await prisma.user.findUnique({
    where: { email: address },
    include: { role: true },
  });

  // A locked account is refused before the hash is even checked, so a guessing
  // run cannot keep testing passwords against it.
  //
  // This message does reveal that the address exists, which the generic refusal
  // below deliberately does not. That is a considered trade: a person locked
  // out otherwise keeps retrying a password that was never the problem, and
  // reaching this state at all costs an attacker LOGIN_MAX_ATTEMPTS tries
  // against a per-IP limit of ten per fifteen minutes.
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
    await logActivity({
      actorId: user.id, actorName: user.name, action: 'LOGIN_BLOCKED',
      summary: `sign-in refused — account locked for another ${minutes} minute(s)`,
      entityType: 'User', entityId: user.id,
    });
    throw new UnauthorizedError(
      `Too many failed attempts for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  // Same error and roughly the same work whether the user exists or not, so
  // the endpoint does not confirm which emails are registered. A disabled
  // account is refused with that same wording for the same reason — the
  // authenticated side of the app says plainly that it was disabled, but this
  // endpoint is unauthenticated and talks to anyone.
  const hash = user?.passwordHash ?? '$argon2id$v=19$m=65536,t=3,p=4$0000000000000000000000$0000000000000000000000000000000';
  const ok = await argon2.verify(hash, password).catch(() => false);

  if (!user || !ok || !user.active) {
    if (user && !ok) {
      // Count the failure and lock the account once it crosses the threshold.
      //
      // The counter is NOT reset when the lock is applied. Keeping it running
      // is what makes a distributed guessing run visible: without it an
      // attacker gets a fresh allowance every lockout window forever, and an
      // administrator looking at the account sees a count of zero.
      const { attempts, locked, lockMinutes } = computeLockout(
        user.failedLoginCount, config.LOGIN_MAX_ATTEMPTS, config.LOGIN_LOCKOUT_MINUTES,
      );
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: attempts,
          lockedUntil: locked ? new Date(Date.now() + lockMinutes * 60_000) : null,
        },
      });
      await logActivity({
        actorId: user.id, actorName: user.name,
        action: locked ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        summary: locked
          ? `account locked for ${lockMinutes} minutes after ${attempts} failed sign-in attempts`
          : `failed sign-in attempt (${attempts} since the last success)`,
        entityType: 'User', entityId: user.id,
        meta: { attempts, locked, lockMinutes, ip: clientIp(req) },
      });
    } else if (user && ok && !user.active) {
      // A correct password for a disabled account. This is the most interesting
      // sign-in event the system can see — someone holds a live credential for
      // an account that was deliberately switched off — so it gets its own
      // record rather than being lost in the generic refusal.
      await logActivity({
        actorId: user.id, actorName: user.name, action: 'LOGIN_DISABLED_ACCOUNT',
        summary: 'correct password presented for a disabled account',
        entityType: 'User', entityId: user.id,
        meta: { ip: clientIp(req) },
      });
    } else if (!user) {
      // No actor to attribute it to, but the attempt itself is worth keeping.
      await logActivity({
        actorName: 'Unknown', action: 'LOGIN_FAILED',
        summary: 'failed sign-in attempt for an unrecognised email address',
        meta: { ip: clientIp(req) },
      });
    }
    throw new UnauthorizedError('Incorrect email or password.');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });

  await logActivity({
    actorId: user.id, actorName: user.name, action: 'LOGIN',
    summary: 'signed in',
    entityType: 'User', entityId: user.id,
    meta: { ip: clientIp(req) },
  });

  res.json({
    token: signToken(user.id, user.email),
    user: toAuthPayload(user),
  });
}));

authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  const u = currentUser(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id }, include: { role: true } });
  res.json(toAuthPayload(user));
}));

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'Choose a password of at least 10 characters.'),
});

// `requestContextMiddleware` is repeated here because /api/auth is mounted
// ahead of the /api chain that normally supplies it. Without it, a person
// changing their own password would appear in the audit trail as "System" —
// the one record you would reach for after a credential incident.
authRouter.post('/change-password', authenticate, requestContextMiddleware, asyncHandler(async (req, res) => {
  const u = currentUser(req);
  const { currentPassword, newPassword } = passwordSchema.parse(req.body);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
  if (!(await argon2.verify(user.passwordHash, currentPassword))) {
    throw new UnauthorizedError('Current password is incorrect.');
  }

  if (currentPassword === newPassword) {
    throw new ValidationError('The new password must be different from the current one.');
  }

  await prisma.user.update({
    where: { id: u.id },
    data: {
      passwordHash: await argon2.hash(newPassword),
      // Clears the block put in place by an administrator's reset.
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  await logActivity({
    actorId: u.id, actorName: u.name, action: 'PASSWORD_CHANGED',
    summary: 'changed their own password',
    entityType: 'User', entityId: u.id,
  });

  res.json({ ok: true });
}));

/** The one shape the client receives for "who am I". */
function toAuthPayload(user: {
  id: string; name: string; email: string; department: string;
  isSuperAdmin: boolean; mustChangePassword: boolean;
  role: { key: string; label: string; permissions: string[] };
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleKey: user.role.key,
    roleLabel: user.role.label,
    department: user.department,
    permissions: user.role.permissions,
    // Mirrors the server-side check exactly: the flag alone is not enough.
    isSuperAdmin: user.isSuperAdmin && isAllowlistedSuperAdmin(user.email),
    mustChangePassword: user.mustChangePassword,
    avatarInitials: initials(user.name),
  };
}

/**
 * The caller's address as Express resolved it under `trust proxy`.
 *
 * Deliberately does NOT read `x-forwarded-for` directly: that header is written
 * by the client and would put an attacker-chosen string into the security log.
 * Express only honours it when TRUST_PROXY says a proxy is actually in front,
 * which is the whole point of that setting.
 */
function clientIp(req: { ip?: string }): string {
  return req.ip ?? 'unknown';
}

function initials(name: string): string {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}
