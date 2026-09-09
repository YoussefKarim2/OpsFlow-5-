-- Any coordinator may work on any order again.
--
-- Order-level access was added two days ago and is withdrawn at the owner's
-- request: the factory works on each other's orders and the grant was friction
-- rather than protection.
--
-- Dropping the table rather than leaving it unread. Nothing in it is lost that
-- is not still on the order: every row came from the backfill of
-- `orders.coordinatorId` and `orders.outsideWorkManagerId`, both of which are
-- untouched and remain what the notification routing means by "responsible for
-- this order". A table nothing reads is a thing that looks like a rule and is
-- not one, which is worse than no table at all.
--
-- The two permissions go with it, so a role cannot carry a grant for a check
-- that no longer runs.
DROP TABLE IF EXISTS "order_assignments";

UPDATE "roles"
   SET "permissions" = array_remove(array_remove("permissions", 'order:assign'), 'order:read-all')
 WHERE ('order:assign' = ANY ("permissions")) OR ('order:read-all' = ANY ("permissions"));
