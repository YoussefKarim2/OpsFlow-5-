-- Give every role `cutting:write`, so the laying & marking Excel import is
-- available to everybody rather than to administrators alone.
--
-- The import was gated on `cutting:write`, which only SUPER_ADMIN, ADMIN and
-- FACTORY_MANAGER held — so in practice one person could see it. The button is
-- on the Marker tab of an order, and the people who work an order are
-- coordinators and the production floor, none of whom had it.
--
-- This migration is required, not tidying. `ROLE_PERMISSIONS` in the shared
-- package is only read by the seed; at runtime a request is authorised against
-- `roles.permissions` in the database (see middleware/auth.ts, which selects
-- `user.role.permissions`). Editing the TypeScript table alone changes what a
-- fresh install gets and nothing about a database already running, and there is
-- no role editor in the admin API to do it by hand — `/admin/roles` is read
-- only. The two have to move together or they drift.
--
-- Idempotent by construction: appending only where the permission is absent
-- means re-running adds nothing and cannot produce a duplicate entry.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'cutting:write')
 WHERE NOT ('cutting:write' = ANY ("permissions"));
