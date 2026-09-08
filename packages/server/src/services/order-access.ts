/**
 * Who may open which order.
 *
 * An order is a customer's commercial terms, prices and margins, so "everybody
 * signed in can read every order" is a decision rather than a default — and it
 * is the one being reversed here. Access is now an explicit grant per order,
 * except for the people who hand out the grants.
 *
 * Enforced in Prisma middleware rather than route by route. There are two dozen
 * places that load an order and the number grows; an access rule applied in
 * twenty-four places is an access rule missing from the twenty-fifth, and for
 * this kind of check that is the whole bug. The middleware sees every query,
 * including ones written after today.
 *
 * A request with no actor — the alert sweep, the change service, the seed — is
 * the system talking to itself and is not filtered. Those paths have no user to
 * check and refusing them would break the notifications rather than protect
 * anything.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { getRequestContext } from '../request-context.js';

/** Set by `authenticate` alongside the actor; read here. */
export interface AccessActor {
  id: string;
  isSuperAdmin: boolean;
  permissions: readonly string[];
}

/**
 * Whether this person sees every order.
 *
 * The super-admin flag is checked as well as the permission, deliberately: it
 * is the same belt-and-braces the account routes use, so a role misconfigured
 * to drop `order:read-all` cannot lock the administrators out of their own
 * system.
 */
export function seesEveryOrder(actor: AccessActor | null): boolean {
  if (!actor) return true;                    // the system, not a person
  return actor.isSuperAdmin || actor.permissions.includes('order:read-all');
}

/**
 * The `where` fragment restricting orders to those a person is on.
 *
 * Returns `{}` for anyone who sees everything, so it can be spread
 * unconditionally into any order query.
 */
export function orderScopeFilter(actor: AccessActor | null): Prisma.OrderWhereInput {
  if (seesEveryOrder(actor)) return {};
  return { assignments: { some: { userId: actor!.id } } };
}

/**
 * Fold the scope into whatever `where` a query already had.
 *
 * `AND` rather than a merge: the caller's conditions and the access rule must
 * both hold, and a caller that happens to use the same key must not be able to
 * overwrite the restriction.
 */
function restrict(where: unknown, actor: AccessActor | null): unknown {
  const scope = orderScopeFilter(actor);
  if (Object.keys(scope).length === 0) return where;
  return where ? { AND: [where, scope] } : scope;
}

/**
 * Apply the order scope to every read of an order.
 *
 * Writes are not filtered here. A write reaches its route only after that route
 * has loaded the order, and that load is filtered — so an unassigned user
 * cannot obtain the id to write to in the first place. Filtering writes as well
 * would silently turn "you may not" into "nothing happened", which is a worse
 * answer than the 404 the read already gives.
 */
export function orderAccessMiddleware(): Prisma.Middleware {
  return async (params, next) => {
    if (params.model !== 'Order') return next(params);
    if (!['findFirst', 'findUnique', 'findMany', 'findFirstOrThrow', 'findUniqueOrThrow', 'count'].includes(params.action)) {
      return next(params);
    }

    const ctx = getRequestContext();
    const actor = ctx?.accessActor ?? null;
    if (seesEveryOrder(actor)) return next(params);

    // `findUnique` takes only a unique field, so a scope cannot be added to it.
    // Promoted to `findFirst`, which accepts the same `where` plus the filter —
    // the reason this is not simply skipped is that `findUnique` is how most of
    // the codebase loads an order by id, and skipping it would leave the door
    // open in exactly the common case.
    if (params.action === 'findUnique' || params.action === 'findUniqueOrThrow') {
      params.action = params.action === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
    }

    params.args = { ...params.args, where: restrict(params.args?.where, actor) };
    return next(params);
  };
}

/**
 * Assert access to one order, for the routes that never load it.
 *
 * A handful of routes act on a child — a carton, a BOM line — and reach the
 * order only through it, so the middleware above never sees an order query.
 * They call this instead.
 */
export async function assertOrderAccess(
  prisma: PrismaClient,
  orderId: string,
): Promise<boolean> {
  const actor = getRequestContext()?.accessActor ?? null;
  if (seesEveryOrder(actor)) return true;
  const found = await prisma.orderAssignment.findFirst({
    where: { orderId, userId: actor!.id },
    select: { id: true },
  });
  return found != null;
}
