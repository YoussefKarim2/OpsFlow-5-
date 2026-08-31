/**
 * Account management — the brief's sections 2 and 3.
 *
 * Every rule that protects the account list lives here rather than in the route
 * handlers, for the same reason the business rules live in `rules.ts`: a rule
 * written once, in a place every caller must pass through, cannot be forgotten
 * by the next endpoint someone adds.
 *
 * The rules, in one place:
 *
 *   1. Super-admin rights require BOTH the database flag and an address on the
 *      `SUPER_ADMIN_EMAILS` allowlist. Neither alone is enough.
 *   2. Nobody can disable, demote, or strip the rights of their own account —
 *      the one lockout that cannot be undone from inside the application.
 *   3. The last remaining super admin cannot be disabled or demoted. There must
 *      always be someone who can let people back in.
 *   4. A reset password is single-use: the account can do nothing but change it.
 *   5. Every one of these actions is logged before it returns.
 */

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Department, Prisma, PrismaClient } from '@prisma/client';
import { ROLE_LABEL, normaliseEmail, type RoleKey } from '@opsflow/shared';
import { prisma } from '../db.js';
import { isAllowlistedSuperAdmin, SUPER_ADMIN_EMAILS } from '../config.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.js';
import { logActivity } from './activity-service.js';
import type { AuthUser } from '../middleware/auth.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface UserRow {
  id: string;
  name: string;
  email: string;
  department: string;
  roleKey: string;
  roleLabel: string;
  active: boolean;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
  /** Failed sign-ins since the last success. Runs across lockouts, so a slow
   *  distributed guessing run is visible rather than resetting every window. */
  failedLoginCount: number;
  lastLoginAt: string | null;
  createdAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
  disabledByName: string | null;
  createdByName: string | null;
  openTaskCount: number;
  orderCount: number;
}

const USER_INCLUDE = {
  role: true,
  disabledBy: { select: { name: true } },
  createdBy: { select: { name: true } },
  _count: {
    select: {
      assignedTasks: { where: { status: { not: 'COMPLETED' as const } } },
      coordinatedOrders: true,
    },
  },
} as const;

type UserWithIncludes = Awaited<ReturnType<typeof loadUser>>;

async function loadUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!user) throw new NotFoundError('User');
  return user;
}

export function toUserRow(u: UserWithIncludes): UserRow {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    department: u.department,
    roleKey: u.role.key,
    roleLabel: u.role.label,
    active: u.active,
    // Presented the same way it is enforced: an address removed from the
    // allowlist reads as "not a super admin" here too, not as a stale yes.
    isSuperAdmin: u.isSuperAdmin && isAllowlistedSuperAdmin(u.email),
    mustChangePassword: u.mustChangePassword,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil.toISOString() : null,
    failedLoginCount: u.failedLoginCount,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    disabledAt: u.disabledAt?.toISOString() ?? null,
    disabledReason: u.disabledReason,
    disabledByName: u.disabledBy?.name ?? null,
    createdByName: u.createdBy?.name ?? null,
    openTaskCount: u._count.assignedTasks,
    orderCount: u._count.coordinatedOrders,
  };
}

export async function listUsers(): Promise<UserRow[]> {
  const users = await prisma.user.findMany({
    include: USER_INCLUDE,
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
  return users.map(toUserRow);
}

export async function getUser(id: string): Promise<UserRow> {
  return toUserRow(await loadUser(id));
}

// ── Guards ──────────────────────────────────────────────────────────────────

function assertNotSelf(actor: AuthUser, targetId: string, action: string): void {
  if (actor.id === targetId) {
    throw new ForbiddenError(
      `You cannot ${action} your own account. Ask another super administrator to do it.`,
    );
  }
}

/**
 * Everyone who can *actually* manage accounts right now.
 *
 * All three conditions, because the API requires all three: the flag, an
 * address still on the allowlist, and a role that grants account management.
 * Counting flag-holders alone would let a phantom quorum form — an account
 * demoted to Coordinator still carries the flag, and would otherwise be
 * counted as cover for removing the last person who can really act.
 */
async function effectiveSuperAdmins(db: Db = prisma): Promise<Array<{ id: string; email: string }>> {
  const holders = await db.user.findMany({
    where: { isSuperAdmin: true, active: true },
    select: { id: true, email: true, role: { select: { permissions: true } } },
  });
  return holders
    .filter((u) => isAllowlistedSuperAdmin(u.email) && u.role.permissions.includes('user:create'))
    .map((u) => ({ id: u.id, email: u.email }));
}

/** Refuse to remove the last person who can let anyone back in. */
async function assertNotLastSuperAdmin(targetId: string, action: string, db: Db = prisma): Promise<void> {
  const effective = await effectiveSuperAdmins(db);
  if (effective.length <= 1 && effective.some((u) => u.id === targetId)) {
    throw new ForbiddenError(
      `This is the only active super administrator. ${action} would leave nobody able to manage accounts. ` +
      'Grant super-admin rights to another allowlisted account first.',
    );
  }
}

/**
 * Run a guard and its write as one serialisable transaction.
 *
 * The guard is a read followed by a write, and at READ COMMITTED two
 * simultaneous requests — A disabling B while B disables A — would both read a
 * count of two, both pass, and both commit, leaving nobody able to manage
 * accounts and no way back in short of editing the database by hand.
 * Serialisable makes the database refuse the second one.
 */
function guarded<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { isolationLevel: 'Serializable' });
}

function assertAllowlisted(email: string): void {
  if (isAllowlistedSuperAdmin(email)) return;
  throw new ForbiddenError(
    `${email} is not on the super-administrator allowlist, so it cannot be granted those rights. ` +
    `Add the address to SUPER_ADMIN_EMAILS first. Currently allowed: ` +
    `${SUPER_ADMIN_EMAILS.length > 0 ? SUPER_ADMIN_EMAILS.join(', ') : '(none configured)'}.`,
  );
}

async function resolveRole(roleKey: string) {
  const role = await prisma.role.findUnique({ where: { key: roleKey } });
  if (!role) {
    throw new ValidationError(`"${roleKey}" is not a role. Choose one of the configured roles.`);
  }
  return role;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export interface CreateUserInput {
  name: string;
  email: string;
  password?: string;
  roleKey: string;
  department: Department;
  phone?: string;
  isSuperAdmin?: boolean;
}

export async function createUser(
  actor: AuthUser,
  input: CreateUserInput,
): Promise<{ user: UserRow; temporaryPassword: string | null }> {
  const email = normaliseEmail(input.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError(`An account already exists for ${email}.`);
  }

  const role = await resolveRole(input.roleKey);

  // Two doors to the same room, and both are locked: the SUPER_ADMIN role and
  // the isSuperAdmin flag each require the address to be on the allowlist.
  const wantsSuperAdmin = input.isSuperAdmin === true || role.key === ('SUPER_ADMIN' satisfies RoleKey);
  if (wantsSuperAdmin) {
    assertAllowlisted(email);
    if (!role.permissions.includes('user:create')) {
      throw new ValidationError(
        `The ${role.label} role does not grant account management, so super-administrator rights ` +
        'would have no effect. Choose the Super Administrator role instead.',
      );
    }
  }

  // Leaving the password blank generates a single-use one. Either way the
  // account must change it on first sign-in: an administrator should never know
  // a colleague's long-term password, whether they typed it or read it out.
  const temporaryPassword = input.password ? null : generatePassword();
  const password = input.password ?? temporaryPassword!;

  const created = await prisma.user.create({
    data: {
      name: input.name.trim(),
      email,
      passwordHash: await argon2.hash(password),
      roleId: role.id,
      department: input.department,
      phone: input.phone?.trim() || null,
      isSuperAdmin: wantsSuperAdmin,
      mustChangePassword: true,
      createdById: actor.id,
    },
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'USER_CREATED',
    summary: `created the account ${email} as ${role.label}${wantsSuperAdmin ? ' with super-administrator rights' : ''}`,
    entityType: 'User', entityId: created.id,
    meta: { email, roleKey: role.key, department: input.department, isSuperAdmin: wantsSuperAdmin },
  });

  return { user: await getUser(created.id), temporaryPassword };
}

export async function setUserActive(
  actor: AuthUser,
  targetId: string,
  active: boolean,
  reason?: string,
): Promise<UserRow> {
  const target = await loadUser(targetId);
  if (target.active === active) return toUserRow(target);

  if (!active) assertNotSelf(actor, targetId, 'disable');

  await guarded(async (tx) => {
    if (!active) await assertNotLastSuperAdmin(targetId, 'Disabling it', tx);
    await tx.user.update({
      where: { id: targetId },
      data: active
        ? { active: true, disabledAt: null, disabledById: null, disabledReason: null, failedLoginCount: 0, lockedUntil: null }
        : { active: false, disabledAt: new Date(), disabledById: actor.id, disabledReason: reason?.trim() || null },
    });
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name,
    action: active ? 'USER_ENABLED' : 'USER_DISABLED',
    summary: active
      ? `re-enabled the account ${target.email}`
      : `disabled the account ${target.email}${reason ? ` — ${reason.trim()}` : ''}`,
    entityType: 'User', entityId: targetId,
    meta: { email: target.email, reason: reason?.trim() ?? null },
  });

  return getUser(targetId);
}

export async function resetPassword(
  actor: AuthUser,
  targetId: string,
): Promise<{ user: UserRow; temporaryPassword: string }> {
  const target = await loadUser(targetId);
  const temporaryPassword = generatePassword();

  await prisma.user.update({
    where: { id: targetId },
    data: {
      passwordHash: await argon2.hash(temporaryPassword),
      mustChangePassword: true,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'USER_PASSWORD_RESET',
    summary: `reset the password for ${target.email}`,
    entityType: 'User', entityId: targetId,
    meta: { email: target.email },
  });

  // Returned once, shown once, never stored in readable form.
  return { user: await getUser(targetId), temporaryPassword };
}

export async function changeRole(actor: AuthUser, targetId: string, roleKey: string): Promise<UserRow> {
  const target = await loadUser(targetId);
  const role = await resolveRole(roleKey);
  if (target.role.key === role.key) return toUserRow(target);

  assertNotSelf(actor, targetId, 'change the role of');

  if (role.key === ('SUPER_ADMIN' satisfies RoleKey)) assertAllowlisted(target.email);

  // Moving to a role that cannot manage accounts takes the flag with it.
  //
  // Leaving the flag behind would create an account that passes the super-admin
  // gate but fails every permission behind it — and, worse, still counts toward
  // the "is there anyone left" check. Demotion has to mean the same thing as
  // revocation, or it becomes the way around it.
  const losesRights = target.isSuperAdmin && !role.permissions.includes('user:create');

  await guarded(async (tx) => {
    if (losesRights) await assertNotLastSuperAdmin(targetId, 'Changing its role', tx);
    await tx.user.update({
      where: { id: targetId },
      data: { roleId: role.id, ...(losesRights ? { isSuperAdmin: false } : {}) },
    });
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'USER_ROLE_CHANGED',
    summary:
      `changed ${target.email} from ${target.role.label} to ${role.label}` +
      (losesRights ? ', which also revoked their super-administrator rights' : ''),
    entityType: 'User', entityId: targetId,
    meta: { email: target.email, from: target.role.key, to: role.key, superAdminRevoked: losesRights },
  });

  return getUser(targetId);
}

export async function setSuperAdmin(actor: AuthUser, targetId: string, value: boolean): Promise<UserRow> {
  const target = await loadUser(targetId);
  if (target.isSuperAdmin === value) return toUserRow(target);

  assertNotSelf(actor, targetId, value ? 'grant super-administrator rights to' : 'revoke super-administrator rights from');

  if (value) {
    assertAllowlisted(target.email);

    // The flag and the permission table are separate gates, and both must open.
    // Granting the flag to an account whose role cannot manage users would
    // produce something that looks like a super admin and behaves like a 403,
    // so it is refused here with the actual fix in the message.
    if (!target.role.permissions.includes('user:create')) {
      throw new ValidationError(
        `${target.name}'s role (${target.role.label}) does not grant account management, ` +
        'so the rights would have no effect. Change their role to Super Administrator first.',
      );
    }
  }

  await guarded(async (tx) => {
    if (!value) await assertNotLastSuperAdmin(targetId, 'Revoking those rights', tx);
    await tx.user.update({ where: { id: targetId }, data: { isSuperAdmin: value } });
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name,
    action: value ? 'USER_SUPERADMIN_GRANTED' : 'USER_SUPERADMIN_REVOKED',
    summary: value
      ? `granted super-administrator rights to ${target.email}`
      : `revoked super-administrator rights from ${target.email}`,
    entityType: 'User', entityId: targetId,
    meta: { email: target.email },
  });

  return getUser(targetId);
}

export interface UpdateUserInput {
  name?: string;
  department?: Department;
  phone?: string | null;
}

export async function updateUserProfile(
  actor: AuthUser,
  targetId: string,
  input: UpdateUserInput,
): Promise<UserRow> {
  const target = await loadUser(targetId);

  await prisma.user.update({
    where: { id: targetId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.department !== undefined ? { department: input.department } : {}),
      ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
    },
  });

  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'USER_UPDATED',
    summary: `updated the account details for ${target.email}`,
    entityType: 'User', entityId: targetId,
    meta: input as Record<string, string | null | undefined> as never,
  });

  return getUser(targetId);
}

/** Clear a lockout early, when the person is standing at the desk asking. */
export async function unlockUser(actor: AuthUser, targetId: string): Promise<UserRow> {
  const target = await loadUser(targetId);
  await prisma.user.update({
    where: { id: targetId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
  await logActivity({
    actorId: actor.id, actorName: actor.name, action: 'USER_UNLOCKED',
    summary: `cleared the sign-in lockout on ${target.email}`,
    entityType: 'User', entityId: targetId,
  });
  return getUser(targetId);
}

export async function listRoles(): Promise<Array<{ key: string; label: string; permissionCount: number; userCount: number }>> {
  const roles = await prisma.role.findMany({
    orderBy: { key: 'asc' },
    include: { _count: { select: { users: true } } },
  });
  return roles.map((r) => ({
    key: r.key,
    label: r.label ?? ROLE_LABEL[r.key as RoleKey] ?? r.key,
    permissionCount: r.permissions.length,
    userCount: r._count.users,
  }));
}

/**
 * A temporary password that can be read aloud over a factory floor without
 * being mistaken: no ambiguous characters, grouped for dictation.
 */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  const bytes = randomBytes(18);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]!);
  return `${chars.slice(0, 6).join('')}-${chars.slice(6, 12).join('')}-${chars.slice(12, 18).join('')}`;
}
