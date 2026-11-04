-- Access given or taken away for one person, on top of their role.
ALTER TABLE "users" ADD COLUMN "grantedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "revokedPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
