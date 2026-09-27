-- The warehouse could write the actual costing but not read it. The sheet only
-- loads the record for a reader, so a warehouse user's first edit autosaved an
-- empty draft and the save replaced the notes, the figures and every hand-added
-- row with it. The warehouse records the materials actually issued on that
-- sheet, so it is given the read it was missing rather than losing the write.
--
-- A migration rather than only the shared table: `ROLE_PERMISSIONS` is read by
-- the seed, while live requests are authorised against `roles.permissions`.
-- Guarded on the array's contents, so a second run changes nothing.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'costing:read')
 WHERE "key" = 'WAREHOUSE'
   AND NOT ('costing:read' = ANY ("permissions"));
