-- Washing and finishing are not operations this factory has. The enum loses
-- them; a production record filed under either would make the cast below
-- fail with an unhelpful message, so the check comes first and says what to do.
DO $$
DECLARE stray INTEGER;
BEGIN
  SELECT COUNT(*) INTO stray FROM "production_records" WHERE "operation"::text IN ('WASHING', 'FINISHING');
  IF stray > 0 THEN
    RAISE EXCEPTION 'Cannot remove WASHING/FINISHING: % production record(s) still use them. Re-file or delete those records first.', stray;
  END IF;
END $$;

-- AlterEnum
BEGIN;
CREATE TYPE "ProductionOperation_new" AS ENUM ('CUTTING', 'SEWING', 'PRINTING', 'EMBROIDERY', 'PACKING');
ALTER TABLE "production_records" ALTER COLUMN "operation" TYPE "ProductionOperation_new" USING ("operation"::text::"ProductionOperation_new");
ALTER TYPE "ProductionOperation" RENAME TO "ProductionOperation_old";
ALTER TYPE "ProductionOperation_new" RENAME TO "ProductionOperation";
DROP TYPE "ProductionOperation_old";
COMMIT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "samMinutes" DECIMAL(8,3);

-- CreateTable
CREATE TABLE "production_day_logs" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "operators" INTEGER,
    "helpers" INTEGER,
    "workingMinutes" INTEGER,
    "machinesRunning" INTEGER,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_day_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_day_logs_date_key" ON "production_day_logs"("date");

-- AddForeignKey
ALTER TABLE "production_day_logs" ADD CONSTRAINT "production_day_logs_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

