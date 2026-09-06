-- Complete the factory's people: a Lead Coordinator role, six accounts, and two
-- corrections.
--
-- Roles and users both live in the database, and `ROLE_PERMISSIONS` in the
-- shared package is read only by the seed — so a new role has to be inserted
-- here as well as declared there, or production never sees it. The permission
-- list below is generated from that same table rather than retyped, so the two
-- cannot disagree.
--
-- Every statement is guarded on what is already present. Re-running inserts no
-- duplicate account, creates no second role, and re-corrects nobody.

-- 1. The Lead Coordinator role.
--
-- Every operational permission and none of the administrative ones: no accounts,
-- no roles, no settings, no audit log. Broad authority over orders is not a
-- reason to hold the power to create accounts, and a role able to grant itself
-- more is bounded by nothing.
INSERT INTO "roles" ("id", "key", "label", "permissions", "isSystem", "createdAt", "updatedAt")
SELECT 'cl' || replace(gen_random_uuid()::text, '-', ''),
       'LEAD_COORDINATOR', 'Lead Coordinator',
       ARRAY['order:read', 'order:create', 'order:edit', 'order:delete', 'task:read', 'task:assign', 'task:complete', 'production:read', 'production:write', 'material:read', 'material:issue', 'material:edit', 'cutting:read', 'cutting:write', 'external:read', 'external:write', 'approval:read', 'approval:request', 'approval:record', 'quality:read', 'quality:audit', 'packing:read', 'packing:write', 'packing:approve', 'shipment:read', 'shipment:write', 'shipment:override', 'costing:read', 'costing:write', 'report:read', 'client:manage', 'factory:manage', 'refdata:manage', 'import:run', 'import:laying']::text[],
       true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
 WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "key" = 'LEAD_COORDINATOR');

-- 2. The six people who had no account.
--
-- Each is created with a random password that was generated, hashed, and thrown
-- away unread — it is in no file, no log and no transcript. The account is
-- therefore unusable until a super administrator issues a temporary one through
-- Reset Password, which is the existing way somebody gets their first
-- credential. `mustChangePassword` then forces them to set their own.
--
-- Not disabled and not half-created: they are ordinary active accounts that
-- nobody yet has the password to.
INSERT INTO "users" (
  "id", "email", "name", "passwordHash", "department", "roleId",
  "active", "isSuperAdmin", "mustChangePassword", "createdAt", "updatedAt"
)
SELECT v.id, v.email, v.name, v.hash, v.dept, r."id",
       true, false, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (VALUES
    ('cld17686138adba42fc8ff3e8b', 'arafaa@soccertex.biz', 'Ahmed Aarfa', '$argon2id$v=19$m=65536,t=3,p=4$WUyLFF5ZAjqKETnKYk6FFQ$ZRkTnR1jVyDi5kAfy7Tc/gRQzLtZbWICzVVL6C/g1qQ', 'CUTTING_MARKER'::"Department", 'FACTORY_MANAGER'),
    ('cld36711b12caff2619d994a4f', 'serag@soccertex.biz', 'Serag Mohamed', '$argon2id$v=19$m=65536,t=3,p=4$VB4I5/2/te3aIF7rh2CM1w$YRs2M9ljLTtTR5rmLX1VGG9idWLOGO02bK2PrAIKJmE', 'CUTTING_MARKER'::"Department", 'FACTORY_MANAGER'),
    ('cl747c5ef46bca4041d8f6dbba', 'ibrahim@soccertex.biz', 'Ibrahim Abozeid', '$argon2id$v=19$m=65536,t=3,p=4$CQlJJawRYTI7v41cQpkrSA$EZRZBeEchHnlsTAgg3L6tqjlDfnRrzPYHyat3/F+ioI', 'COORDINATOR'::"Department", 'COORDINATOR'),
    ('cl96862dd949e941b70bd4d09c', 'samy@soccertex.biz', 'Ahmed Samy Abozeid', '$argon2id$v=19$m=65536,t=3,p=4$VozCQ7kHFfuXbySB2xWSCw$JcNa3wHqc0SX0NqkIeLf+7KlRLrNUDO5R9QbdgJMAAg', 'COORDINATOR'::"Department", 'LEAD_COORDINATOR'),
    ('cle3777af0e158f2de77f14408', 'mahmoud@soccertex.biz', 'Mahmoud Mostafa', '$argon2id$v=19$m=65536,t=3,p=4$dWXEG/91byD2T7EytOUNNw$szq65X3XmclwWpRgmRtEWJl6WKoU6ah/t9QjIhknHRw', 'FACTORY_MANAGER'::"Department", 'FACTORY_MANAGER'),
    ('clb69f1c88c08129dbd8317810', 'ragab@soccertex.biz', 'Mahmoud Ragab', '$argon2id$v=19$m=65536,t=3,p=4$jlSLJygiXVBDsqdbepgGgA$6B0WV7LcqUJ9fuY5dgVV8bANW+ZIhG0NgDav4IjRfBo', 'FINANCE'::"Department", 'FINANCE')
  ) AS v(id, email, name, hash, dept, role_key)
  JOIN "roles" r ON r."key" = v.role_key
 WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."email" = v.email);

-- 3. Sabry and Helmy are coordinators.
--
-- They were seeded into PACKING and EXTERNAL_OPS, which is what they were
-- carrying when `import:laying` was granted to those two roles so they could
-- file the laying sheet. Moving them to the role they actually hold makes that
-- grant unnecessary, and step 4 withdraws it.
--
-- Only `roleId` changes. Their accounts, addresses, history and assignments are
-- theirs and are not this migration's business.
UPDATE "users" u
   SET "roleId" = (SELECT "id" FROM "roles" WHERE "key" = 'COORDINATOR')
 WHERE u."email" IN ('sabry@soccertex.biz', 'helmy@soccertex.biz')
   AND u."roleId" <> (SELECT "id" FROM "roles" WHERE "key" = 'COORDINATOR');

-- 4. Withdraw the laying import from PACKING and EXTERNAL_OPS.
--
-- Those roles only received it to reach the two people above, who are now
-- coordinators and get it from COORDINATOR instead. Left in place it would be a
-- standing grant to whoever holds those roles next, for a reason that no longer
-- exists.
UPDATE "roles"
   SET "permissions" = array_remove("permissions", 'import:laying')
 WHERE "key" IN ('PACKING', 'EXTERNAL_OPS')
   AND ('import:laying' = ANY ("permissions"));
