-- CreateTable
CREATE TABLE "alert_states" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "lastSnapshot" TEXT NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_states_code_entityType_entityId_key" ON "alert_states"("code", "entityType", "entityId");

