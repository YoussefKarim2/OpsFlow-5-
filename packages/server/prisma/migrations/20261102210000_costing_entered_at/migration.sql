-- When the factory's daily cost and machine count were last entered on a costing.
ALTER TABLE "costing_records" ADD COLUMN "dailyCostEnteredAt" TIMESTAMP(3), ADD COLUMN "machineCountEnteredAt" TIMESTAMP(3);
-- Existing costings: their last save is the best record of when the figure was entered.
UPDATE "costing_records" SET "dailyCostEnteredAt" = "updatedAt" WHERE "dailyCostUsd" IS NOT NULL;
UPDATE "costing_records" SET "machineCountEnteredAt" = "updatedAt" WHERE "machineCount" IS NOT NULL;
