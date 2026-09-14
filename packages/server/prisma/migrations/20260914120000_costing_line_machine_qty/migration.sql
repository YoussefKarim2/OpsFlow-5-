-- The Actual Costing sheet takes "Line Machines Qty" as its own input,
-- alongside the factory-wide machine count. Neither is derivable from the
-- other and nothing else in the application recorded it.
--
-- Nullable with no default: an order costed before this existed has not
-- answered the question, which is not the same as having answered zero.
ALTER TABLE "costing_records" ADD COLUMN "lineMachineQty" INTEGER;
