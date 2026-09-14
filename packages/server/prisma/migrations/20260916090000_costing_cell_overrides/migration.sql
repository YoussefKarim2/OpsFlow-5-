-- Every cell of the Actual Costing sheet can be written by hand, including the
-- calculated ones. The typed figures are stored here rather than written back
-- over the ledgers, the bill of materials or the order, so the facts stay as
-- production recorded them and an override can always be cleared.
--
-- Nullable with no default: no costing has any overrides until somebody types
-- one, and an empty object would be indistinguishable from that.
ALTER TABLE "costing_records" ADD COLUMN "overrides" JSONB;
