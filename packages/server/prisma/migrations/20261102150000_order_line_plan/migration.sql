-- Production tab: target production per day and the line's machine table.
ALTER TABLE "orders" ADD COLUMN "targetPerDay" INTEGER, ADD COLUMN "productionLineName" TEXT, ADD COLUMN "lineMachines" JSONB;
