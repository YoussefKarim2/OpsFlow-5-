-- Let a coordinator record production.
--
-- Step 13 of the flow was read-only for coordinators: the Production tab hid its
-- controls and the route answered 403. The role's own definition says the
-- coordinator "owns the order end to end" and names its exclusions — issuing
-- material and signing off quality, which stay with the departments accountable
-- for them. Production was never one of those, and most of the factory's people
-- hold this role, so the section was effectively unusable.
--
-- Required rather than tidying: `ROLE_PERMISSIONS` in the shared package is read
-- only by the seed, while a live request is authorised against
-- `roles.permissions` in this database. Guarded on the array's contents, so a
-- second run changes nothing.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'production:write')
 WHERE "key" = 'COORDINATOR'
   AND NOT ('production:write' = ANY ("permissions"));
