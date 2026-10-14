-- OpsFlow holds one currency: US dollars.
--
-- The costing's daily cost was stored in Egyptian pounds beside the rate it
-- was converted at; typed-over machine costs were pounds per machine-day too.
-- Each is converted once here, at the rate stored with it, and the rate, the
-- pound columns and the proforma's currency column go. A pound figure with no
-- rate to convert it at is left blank rather than kept as a number that would
-- now read as dollars; the sheet asks for it.

ALTER TABLE "costing_records" ADD COLUMN "dailyCostUsd" DECIMAL(14,4);

UPDATE "costing_records"
SET "dailyCostUsd" = ROUND("dailyCostEgp" / "dollarRate", 4)
WHERE "dailyCostEgp" IS NOT NULL AND "dollarRate" IS NOT NULL AND "dollarRate" > 0;

-- The override keyed machineCostEgpPerDay becomes machineCostPerDay, in dollars.
UPDATE "costing_records"
SET "overrides" = ("overrides" - 'machineCostEgpPerDay')
  || jsonb_build_object('machineCostPerDay', ROUND(("overrides"->>'machineCostEgpPerDay')::numeric / "dollarRate", 4))
WHERE jsonb_typeof("overrides") = 'object'
  AND "overrides" ? 'machineCostEgpPerDay'
  AND jsonb_typeof("overrides"->'machineCostEgpPerDay') = 'number'
  AND "dollarRate" IS NOT NULL AND "dollarRate" > 0;

UPDATE "costing_records"
SET "overrides" = "overrides" - 'machineCostEgpPerDay'
WHERE jsonb_typeof("overrides") = 'object' AND "overrides" ? 'machineCostEgpPerDay';

ALTER TABLE "costing_records" DROP COLUMN "dollarRate";
ALTER TABLE "costing_records" DROP COLUMN "dailyCostEgp";

ALTER TABLE "cost_lines" DROP COLUMN "unitPriceEgp";

ALTER TABLE "proforma_invoices" DROP COLUMN "currency";
