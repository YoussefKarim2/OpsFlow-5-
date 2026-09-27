-- When the cut order was last written. Without it, a cut order that stock had
-- emptied (every cell covered) looked never-generated and stopped refreshing.
ALTER TABLE "orders" ADD COLUMN "cutOrderGeneratedAt" TIMESTAMP(3);

-- Every order that already has a cut order was generated at some point; the
-- exact moment is not recorded, so "now" stands in for it.
UPDATE "orders" o
SET "cutOrderGeneratedAt" = now()
WHERE EXISTS (
  SELECT 1 FROM "stage_quantities" q WHERE q."orderId" = o."id" AND q."ledger" = 'CUT'
);

-- Balances with no location: the (materialId, locationId) unique index lets
-- NULLs repeat, so concurrent first receipts could create two balance rows for
-- one material. Merge any such duplicates into one row (the lowest id), summing
-- the quantities so no stock disappears, before the index forbids them.
WITH ranked AS (
  SELECT "id", "materialId",
         ROW_NUMBER() OVER (PARTITION BY "materialId" ORDER BY "id") AS rn,
         SUM("physicalQty") OVER (PARTITION BY "materialId") AS total
  FROM "material_stock"
  WHERE "locationId" IS NULL
)
UPDATE "material_stock" s
SET "physicalQty" = r.total, "updatedAt" = now()
FROM ranked r
WHERE s."id" = r."id" AND r.rn = 1
  AND EXISTS (SELECT 1 FROM ranked d WHERE d."materialId" = r."materialId" AND d.rn > 1);

DELETE FROM "material_stock" s
USING (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "materialId" ORDER BY "id") AS rn
  FROM "material_stock"
  WHERE "locationId" IS NULL
) d
WHERE s."id" = d."id" AND d.rn > 1;

CREATE UNIQUE INDEX "material_stock_materialId_null_location_key"
  ON "material_stock"("materialId")
  WHERE "locationId" IS NULL;
