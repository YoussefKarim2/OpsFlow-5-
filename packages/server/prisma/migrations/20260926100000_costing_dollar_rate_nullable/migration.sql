-- The dollar rate is no longer assumed. It defaulted to 48.5, and the costing
-- sheet's first autosave stored that default, so "Waiting for the dollar rate"
-- could never appear and every conversion ran at a rate nobody had chosen.
-- Rates already stored are left exactly as they are.
ALTER TABLE "costing_records" ALTER COLUMN "dollarRate" DROP DEFAULT;
ALTER TABLE "costing_records" ALTER COLUMN "dollarRate" DROP NOT NULL;
