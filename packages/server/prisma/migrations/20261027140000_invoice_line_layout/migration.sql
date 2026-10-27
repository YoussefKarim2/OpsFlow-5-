-- How a document lists its goods: every colour and size, or one line per order.
ALTER TABLE "invoices" ADD COLUMN "lineLayout" TEXT NOT NULL DEFAULT 'DETAILED';
