-- Make youssefk@soccertex.biz a super administrator.
--
-- The address is spelled with a double "s" — youssefk, not yousefk. That is the
-- mailbox on the confirmed Microsoft 365 tenant list and the account that exists
-- in this database; the single-s spelling matches no mailbox and no user, and
-- creating it would repeat the admin@soccertex.biz mistake that this project has
-- already paid for once.
--
-- Two things make a super administrator, and this migration only supplies one.
-- `requireSuperAdmin` reads the `isSuperAdmin` column, which is set below. The
-- environment's SUPER_ADMIN_EMAILS allowlist governs the other half: the seed
-- revokes the flag from any address not on it, and user-service refuses to grant
-- it through the API. The allowlist must therefore name this address too, in
-- config.ts for a fresh install and in the deployment's own environment for this
-- one, or the next seed run quietly takes the rights away again.
--
-- Idempotent: the guard excludes rows already in the target state, so a second
-- run updates nothing. Scoped to one address, so no other account's role or flag
-- is touched — Ahmed and Laila keep theirs, and admin@soccertex.biz, which is
-- seed data rather than a real mailbox, is deliberately not involved.
UPDATE "users" u
   SET "isSuperAdmin" = true,
       "roleId" = (SELECT r."id" FROM "roles" r WHERE r."key" = 'SUPER_ADMIN')
 WHERE u."email" = 'youssefk@soccertex.biz'
   AND EXISTS (SELECT 1 FROM "roles" r WHERE r."key" = 'SUPER_ADMIN')
   AND (u."isSuperAdmin" = false
        OR u."roleId" <> (SELECT r."id" FROM "roles" r WHERE r."key" = 'SUPER_ADMIN'));

-- Recorded where account changes are recorded. Raw SQL bypasses the Prisma audit
-- middleware, and granting super-administrator rights is the most
-- security-relevant change this system allows; it should not be inferable only
-- from a deployment log.
INSERT INTO "activity_logs" ("id", "actorName", "action", "summary", "entityType", "entityId", "createdAt")
SELECT 'cl_' || replace(gen_random_uuid()::text, '-', ''),
       'Migration', 'USER_SUPERADMIN_GRANTED',
       'granted super-administrator rights to ' || u."email",
       'User', u."id", CURRENT_TIMESTAMP
  FROM "users" u
 WHERE u."email" = 'youssefk@soccertex.biz'
   AND u."isSuperAdmin" = true
   AND NOT EXISTS (
     SELECT 1 FROM "activity_logs" l
      WHERE l."action" = 'USER_SUPERADMIN_GRANTED' AND l."entityId" = u."id"
   );
