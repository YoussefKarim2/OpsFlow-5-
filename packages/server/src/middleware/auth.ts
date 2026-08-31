import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Permission } from '@opsflow/shared';
import { config, isAllowlistedSuperAdmin } from '../config.js';
import { prisma } from '../db.js';
import { UnauthorizedError, ForbiddenError, PasswordChangeRequiredError } from '../errors.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  roleKey: string;
  department: string;
  permissions: string[];
  /** True only if the flag is set AND the address is still on the allowlist. */
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface JwtPayload {
  sub: string;
  email: string;
}

export function signToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email } satisfies JwtPayload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Verifies the bearer token and loads the user's current role and permissions
 * from the database on every request.
 *
 * Permissions are deliberately NOT baked into the token. If an admin revokes a
 * permission, it must take effect now, not when a 12-hour token expires.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();

    const token = header.slice(7);
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    } catch {
      throw new UnauthorizedError('Session expired or invalid. Please sign in again.');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    });

    if (!user) throw new UnauthorizedError('Session expired or invalid. Please sign in again.');

    // The token was valid, so the holder already knows this account exists —
    // saying plainly that it was switched off is useful, not a disclosure.
    // (The login endpoint stays deliberately vague; see routes/auth.ts.)
    if (!user.active) {
      throw new UnauthorizedError(
        'This account has been disabled. Contact an administrator to have it re-enabled.',
      );
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      roleKey: user.role.key,
      department: user.department,
      permissions: user.role.permissions,
      // Re-checked against the allowlist on every request, so removing an
      // address from SUPER_ADMIN_EMAILS revokes the power at the next call
      // rather than at the next deploy.
      isSuperAdmin: user.isSuperAdmin && isAllowlistedSuperAdmin(user.email),
      mustChangePassword: user.mustChangePassword,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * After an administrator resets a password, the account can do exactly two
 * things until it sets a new one: read itself, and change its password.
 *
 * Enforced server-side rather than by redirecting in the UI, because a reset
 * password is a credential someone else has seen.
 */
export function enforcePasswordChange(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.mustChangePassword) return next();

  // /api/auth/* is mounted ahead of this middleware, so `me` and
  // `change-password` — the two things the account still needs — never reach
  // here. Everything that does reach here is refused.
  next(new PasswordChangeRequiredError());
}

/**
 * The account-management gate.
 *
 * Deliberately independent of the permission table: a role misconfiguration
 * cannot open this door, because the check is on the user's own flag and the
 * environment allowlist, both resolved in `authenticate` above.
 */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new UnauthorizedError());
  if (!req.user.isSuperAdmin) {
    return next(
      new ForbiddenError(
        'Only a super administrator can manage user accounts. ' +
        'If you should have this access, ask one of the existing super administrators to grant it.',
      ),
    );
  }
  next();
}

/** Gate a route on a single permission. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthorizedError());
    if (!req.user.permissions.includes(permission)) {
      return next(new ForbiddenError(`This action requires the "${permission}" permission.`));
    }
    next();
  };
}

/** Gate a route on any one of several permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthorizedError());
    if (!permissions.some((p) => req.user!.permissions.includes(p))) {
      return next(new ForbiddenError(`This action requires one of: ${permissions.join(', ')}.`));
    }
    next();
  };
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}
