/**
 * Failed sign-ins per account AND address, and the locks they lead to.
 *
 * The lock follows the place the guessing comes from, not the account: an
 * account-wide lock let anyone who knew a staff address keep that person, and
 * every super admin, locked out for a day at a time with a handful of
 * requests. Someone guessing from one address is locked out there; the owner
 * signing in from anywhere else is not. In memory on purpose: a restart
 * forgets a lock, and the per-address limiter still bounds every caller.
 *
 * Kept here rather than in the login route so that an administrator's unlock,
 * a password reset and re-enabling an account can clear it: clearing only the
 * database columns left the person locked out with a new password in hand.
 */
export const pairFailures = new Map<string, number>();
export const pairLocks = new Map<string, number>();
export const pairKey = (userId: string, ip: string) => `${userId}|${ip}`;

/** Forget every failure and lock this account has, from any address. */
export function clearLoginLocks(userId: string): void {
  const prefix = `${userId}|`;
  for (const k of [...pairFailures.keys()]) if (k.startsWith(prefix)) pairFailures.delete(k);
  for (const k of [...pairLocks.keys()]) if (k.startsWith(prefix)) pairLocks.delete(k);
}
