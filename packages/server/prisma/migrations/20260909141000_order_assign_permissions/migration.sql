-- Grant the two order-access permissions in the database.
--
-- `order:assign` is permission to decide who may work on an order;
-- `order:read-all` is the bypass that lets somebody find an order nobody is on
-- yet, without which the first assignment could never be made.
--
-- Both go to the super administrators and to the Lead Coordinator, and to
-- nobody else — including ADMIN, which otherwise holds everything that is not
-- super-admin-only. Access control is narrower than administration, and the
-- people who exercise it were named individually.
--
-- Required rather than tidying, and the reason is the same every time: a live
-- request is authorised against `roles.permissions` here, while the shared
-- table is read only by the seed. Guarded, so a second run changes nothing.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'order:assign')
 WHERE "key" IN ('SUPER_ADMIN', 'LEAD_COORDINATOR')
   AND NOT ('order:assign' = ANY ("permissions"));

UPDATE "roles"
   SET "permissions" = array_append("permissions", 'order:read-all')
 WHERE "key" IN ('SUPER_ADMIN', 'LEAD_COORDINATOR')
   AND NOT ('order:read-all' = ANY ("permissions"));
