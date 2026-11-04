-- A sheet fabric with no lay of its own counts on the BOM in its own right.
ALTER TABLE "fabric_records" ADD COLUMN "standalone" BOOLEAN NOT NULL DEFAULT false;
-- Existing imports: a fabric no lay names today is taken as standalone.
UPDATE "fabric_records" f SET "standalone" = true
WHERE f."importJobId" IS NOT NULL AND f."requiredM" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "markers" m
    WHERE m."orderId" = f."orderId"
      AND lower(trim(m."fabricName")) = lower(trim(f."fabricName"))
      AND lower(trim(coalesce(m."fabricColor", ''))) = lower(trim(coalesce(f."colorName", '')))
  );
