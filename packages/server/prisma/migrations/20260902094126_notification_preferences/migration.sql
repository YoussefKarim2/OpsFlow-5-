-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TASK_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE 'MATERIAL_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'PRODUCTION_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'QUALITY_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'SYSTEM_UPDATE';

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "ChangeCategory" NOT NULL,
    "minPriority" "NotificationPriority" NOT NULL DEFAULT 'LOW',
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_category_key" ON "notification_preferences"("userId", "category");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

