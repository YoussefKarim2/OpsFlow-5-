-- Order Details: as many fabrics as the order uses (past fabric, fabric2, fabric3).
ALTER TABLE "orders" ADD COLUMN "moreFabrics" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
