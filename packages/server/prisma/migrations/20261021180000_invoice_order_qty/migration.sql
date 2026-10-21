-- Each order's share of a document's pieces, so an order whose goods are only
-- partly on a shared invoice stays on "Ready to invoice".
ALTER TABLE "invoice_orders" ADD COLUMN "qty" INTEGER;

-- The back-fill again, for any document created by a server still running the
-- previous release while invoice_orders already existed.
INSERT INTO "invoice_orders" ("id", "invoiceId", "orderId", "packingListId", "shipmentId", "position", "orderRef")
SELECT 'io_' || i."id", i."id", i."orderId", i."packingListId", i."shipmentId", 0, i."orderRef"
FROM "invoices" i
WHERE NOT EXISTS (SELECT 1 FROM "invoice_orders" io WHERE io."invoiceId" = i."id");

-- A document over one order: that order's share is all of its goods.
UPDATE "invoice_orders" io
SET "qty" = sub.q
FROM (
  SELECT l."invoiceId", ROUND(SUM(l."quantity"))::int AS q
  FROM "invoice_lines" l
  WHERE l."kind" = 'ITEM' AND l."quantity" IS NOT NULL
  GROUP BY l."invoiceId"
) sub
WHERE io."invoiceId" = sub."invoiceId"
  AND io."qty" IS NULL
  AND (SELECT COUNT(*) FROM "invoice_orders" x WHERE x."invoiceId" = io."invoiceId") = 1;
