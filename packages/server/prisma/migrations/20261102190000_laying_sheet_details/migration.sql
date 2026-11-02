-- Laying & Marking: nest may be a half; efficiency stored as a percentage;
-- the fabric table's Description and Issued to kept on the fabric record.
ALTER TABLE "markers" ALTER COLUMN "nestPcs" TYPE DECIMAL(10,2);
-- Imported sheets stored EFF% as a fraction (0.81 for 81%); the column is a percentage.
UPDATE "markers" SET "efficiencyPct" = "efficiencyPct" * 100 WHERE "efficiencyPct" > 0 AND "efficiencyPct" <= 1.5;
ALTER TABLE "fabric_records" ADD COLUMN "description" TEXT, ADD COLUMN "issuedTo" TEXT;
-- "Issued to CUT", which earlier imports wrote into the notes, moves to its own column.
UPDATE "fabric_records" SET "issuedTo" = substring("notes" from '^Issued to (.+)$'), "notes" = NULL
  WHERE "importJobId" IS NOT NULL AND "notes" ~ '^Issued to .+$';
