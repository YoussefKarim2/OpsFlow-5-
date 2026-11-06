-- Outside-work prices to six decimal places, as costing prices are: a rate of
-- 0.00375 was stored as 0.0038. Widening keeps every stored value.
ALTER TABLE "external_operations" ALTER COLUMN "unitPriceUsd" TYPE DECIMAL(14,6);
