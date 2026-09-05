/**
 * RBAC. Permissions are `resource:action` strings; roles are data, not an enum,
 * so an administrator can create "Senior Coordinator" without a deploy.
 */

export const PERMISSIONS = [
  'order:read', 'order:create', 'order:edit', 'order:delete',
  'task:read', 'task:assign', 'task:complete',
  'production:read', 'production:write',
  'material:read', 'material:issue', 'material:edit',
  'cutting:read', 'cutting:write',
  'external:read', 'external:write',
  'approval:read', 'approval:request', 'approval:record',
  'quality:read', 'quality:audit',
  'packing:read', 'packing:write', 'packing:approve',
  'shipment:read', 'shipment:write', 'shipment:override',
  'costing:read', 'costing:write',
  'report:read',
  'client:manage', 'factory:manage', 'refdata:manage',
  // Administration. `user:manage` is the umbrella that opens the admin area and
  // lists accounts; the four below are the individual dangerous actions, so a
  // role can be given visibility without being given the ability to act.
  'user:manage', 'user:create', 'user:disable', 'user:reset-password',
  'role:manage', 'role:assign',
  'audit:read', 'settings:manage',
  'import:run',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The account-mutating permissions. Holding one of these is necessary but NOT
 * sufficient: every route behind them is additionally gated on the super-admin
 * flag, so a compromised or over-generous role still cannot mint an account.
 */
export const SUPER_ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  'user:create', 'user:disable', 'user:reset-password', 'role:assign', 'settings:manage',
];

export const ROLE_KEYS = [
  'SUPER_ADMIN', 'ADMIN', 'COORDINATOR', 'FACTORY_MANAGER', 'PRODUCTION_MANAGER',
  'WAREHOUSE', 'QUALITY', 'EXTERNAL_OPS', 'PACKING', 'FOLLOW_UP', 'FINANCE',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const READ_ONLY: Permission[] = [
  'order:read', 'task:read', 'production:read', 'material:read',
  'cutting:read', 'external:read', 'approval:read', 'quality:read',
  'packing:read', 'shipment:read', 'report:read',
];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  // The only role that may create, disable, reset or re-role an account — and
  // even then only for a holder whose email is on the configured allowlist.
  SUPER_ADMIN: [...PERMISSIONS],

  // Everything operational, plus visibility of accounts and the audit log, but
  // none of the account-mutating actions. An administrator runs the factory;
  // three named people run the user list.
  ADMIN: PERMISSIONS.filter(
    (p) => !SUPER_ADMIN_ONLY_PERMISSIONS.includes(p),
  ) as Permission[],

  // The most important user. Sees everything, owns the order end to end,
  // but does not issue materials or sign off quality — those stay with the
  // departments accountable for them.
  COORDINATOR: [
    ...READ_ONLY,
    'order:create', 'order:edit',
    'task:assign', 'task:complete',
    'material:edit',
    'external:write',
    'approval:request', 'approval:record',
    'packing:write', 'packing:approve',
    'shipment:write',
    'costing:read', 'costing:write',
    'import:run',
  ],

  FACTORY_MANAGER: [
    ...READ_ONLY,
    'order:create', 'order:edit',
    'task:assign', 'task:complete',
    'production:write',
    'cutting:write',
    'approval:record',
    'costing:read',
  ],

  PRODUCTION_MANAGER: [...READ_ONLY, 'production:write', 'task:complete'],

  WAREHOUSE: [...READ_ONLY, 'material:issue', 'material:edit', 'task:complete', 'costing:write'],

  QUALITY: [...READ_ONLY, 'quality:audit', 'task:complete', 'task:assign'],

  EXTERNAL_OPS: [...READ_ONLY, 'external:write', 'approval:request', 'task:complete'],

  PACKING: [...READ_ONLY, 'packing:write', 'task:complete'],

  FOLLOW_UP: [...READ_ONLY, 'production:write', 'task:complete'],

  FINANCE: [...READ_ONLY, 'costing:read', 'costing:write'],
};

export const ROLE_LABEL: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Super Administrator',
  ADMIN: 'Administrator',
  COORDINATOR: 'Order Coordinator',
  FACTORY_MANAGER: 'Factory Manager',
  PRODUCTION_MANAGER: 'Production Manager',
  WAREHOUSE: 'Warehouse',
  QUALITY: 'Quality / Audit',
  EXTERNAL_OPS: 'External Operations',
  PACKING: 'Packing',
  FOLLOW_UP: 'Follow-up Officer',
  FINANCE: 'Finance',
};

/** One spelling of an address everywhere, so an allowlist match cannot be defeated by case or a stray space. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Parse a comma-, semicolon- or whitespace-separated list of addresses from a
 * single environment variable, normalised and de-duplicated.
 *
 * Kept here rather than in the server config so the same parsing is available
 * to the seed script and to any future admin UI that previews one of these
 * lists — and so that two settings which are both "a list of addresses" cannot
 * drift into two slightly different notions of what that means.
 */
export function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,;\s]+/).map(normaliseEmail).filter((e) => e.includes('@')))];
}

/** The `SUPER_ADMIN_EMAILS` setting. See {@link parseEmailList}. */
export function parseSuperAdminEmails(raw: string | null | undefined): string[] {
  return parseEmailList(raw);
}

/**
 * Sign-in lockout, as a pure function so it can be reasoned about and tested
 * without a database.
 *
 * Two properties matter and both are easy to get wrong:
 *
 *   The counter is never reset by a lockout, only by a successful sign-in or an
 *   administrator. Resetting it at the lock would hand an attacker a fresh
 *   allowance every window, forever, and show the administrator a count of zero
 *   on an account under attack.
 *
 *   Each successive lockout is twice as long as the last, to a ceiling. A fixed
 *   window is a speed limit; a doubling one is a wall.
 */
export function computeLockout(
  previousFailures: number,
  maxAttempts: number,
  baseMinutes: number,
  ceilingMinutes = 24 * 60,
): { attempts: number; locked: boolean; lockMinutes: number } {
  const attempts = previousFailures + 1;
  const locked = attempts > 0 && attempts % maxAttempts === 0;
  if (!locked) return { attempts, locked: false, lockMinutes: 0 };

  const round = Math.floor(attempts / maxAttempts); // 1, 2, 3, …
  const lockMinutes = Math.min(baseMinutes * 2 ** (round - 1), ceilingMinutes);
  return { attempts, locked: true, lockMinutes };
}

export function can(permissions: readonly string[], required: Permission): boolean {
  return permissions.includes(required);
}

export function canAny(permissions: readonly string[], required: readonly Permission[]): boolean {
  return required.some((r) => permissions.includes(r));
}
