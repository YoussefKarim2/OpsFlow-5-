-- CreateEnum
CREATE TYPE "ImportTarget" AS ENUM ('NEW_ORDER', 'LAYING_MARKING');

-- AlterTable
ALTER TABLE "cutting_records" ADD COLUMN     "importJobId" TEXT;

-- AlterTable
ALTER TABLE "fabric_records" ADD COLUMN     "importJobId" TEXT;

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "target" "ImportTarget" NOT NULL DEFAULT 'NEW_ORDER',
ADD COLUMN     "targetOrderId" TEXT;

-- AlterTable
ALTER TABLE "markers" ADD COLUMN     "importJobId" TEXT,
ADD COLUMN     "markerWidthM" DECIMAL(10,3),
ADD COLUMN     "wastagePct" DECIMAL(6,3);

-- CreateIndex
CREATE INDEX "cutting_records_importJobId_idx" ON "cutting_records"("importJobId");

-- CreateIndex
CREATE INDEX "fabric_records_importJobId_idx" ON "fabric_records"("importJobId");

-- CreateIndex
CREATE INDEX "import_jobs_targetOrderId_target_status_idx" ON "import_jobs"("targetOrderId", "target", "status");

-- CreateIndex
CREATE INDEX "markers_importJobId_idx" ON "markers"("importJobId");

-- AddForeignKey
ALTER TABLE "cutting_records" ADD CONSTRAINT "cutting_records_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "import_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markers" ADD CONSTRAINT "markers_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "import_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fabric_records" ADD CONSTRAINT "fabric_records_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "import_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_targetOrderId_fkey" FOREIGN KEY ("targetOrderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

