-- A costing row derived from the bill of materials or the outside work can be
-- removed from the sheet. Recorded by source reference rather than by row id,
-- because the rows themselves are rebuilt on every save and a deleted one
-- would otherwise come straight back.
ALTER TABLE "costing_records" ADD COLUMN "hiddenCostRefs" TEXT[] DEFAULT ARRAY[]::TEXT[];
