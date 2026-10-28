-- The factory proforma sheet's typed fields; null until a sheet is used.
ALTER TABLE "invoices" ADD COLUMN "sheet" JSONB;
