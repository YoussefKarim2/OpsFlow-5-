-- The order's identity (PO, name, style, client) is snapshotted onto the
-- invoice when it is built, so an issued document keeps the header it was
-- sent with if the order is renamed afterwards. Nullable and additive: a row
-- without one is read from the order until it is next rebuilt.
ALTER TABLE "invoices" ADD COLUMN "orderRef" JSONB;
