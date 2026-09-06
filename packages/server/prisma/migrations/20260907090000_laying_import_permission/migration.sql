-- Separate running the laying & marking import from writing cutting data.
--
-- The import was gated on `cutting:write`, so the previous migration granted
-- that permission to all eleven roles to make the button reachable. It worked
-- and it was too broad: `cutting:write` also guards adding and deleting markers,
-- recording cutting, and regenerating a cut order from the quantity matrix — so
-- Finance and Packing gained the ability to rewrite the CUT ledger in order to
-- file a spreadsheet.
--
-- `import:laying` now gates the four import routes and nothing else. The four
-- cutting operations above still require `cutting:write`, unchanged.
--
-- Required rather than tidying: `ROLE_PERMISSIONS` in the shared package is read
-- only by the seed, while a live request is authorised against
-- `roles.permissions` in this database (middleware/auth.ts selects
-- `user.role.permissions`). There is no role editor in the admin API —
-- `/admin/roles` is read-only — so the seed and the database can only be kept
-- together by a migration.
--
-- Both statements are guarded on the array's contents, so a second run makes no
-- further change and cannot duplicate an entry.

-- 1. Grant the new permission to the roles whose people actually file the sheet:
--    coordinators, the factory floor, external ops and packing. Deliberately not
--    Finance, Warehouse, Quality, Production Manager or Follow-Up — the rule is
--    that the people who need the import get it, not that every role does.
--    ADMIN and SUPER_ADMIN are listed explicitly because they hold the whole
--    permission set by construction in the shared table, and a new permission
--    has to be added to their stored rows to match.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'import:laying')
 WHERE "key" IN ('SUPER_ADMIN', 'ADMIN', 'COORDINATOR', 'FACTORY_MANAGER', 'EXTERNAL_OPS', 'PACKING')
   AND NOT ('import:laying' = ANY ("permissions"));

-- 2. Take `cutting:write` back off the roles that only received it to reach the
--    import. SUPER_ADMIN, ADMIN and FACTORY_MANAGER are absent from this list
--    because they held it before that fix, for reasons that have nothing to do
--    with importing: they are the roles that actually cut.
UPDATE "roles"
   SET "permissions" = array_remove("permissions", 'cutting:write')
 WHERE "key" IN ('COORDINATOR', 'PRODUCTION_MANAGER', 'WAREHOUSE', 'QUALITY',
                 'EXTERNAL_OPS', 'PACKING', 'FOLLOW_UP', 'FINANCE')
   AND ('cutting:write' = ANY ("permissions"));
