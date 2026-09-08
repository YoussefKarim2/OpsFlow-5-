-- A carton can hold more than one size.
--
-- Purely additive. `cartons.orderSizeId` and `cartons.qty` are untouched and
-- still carry the single-size case, so every carton packed before today remains
-- correct and readable by the code that reads it. A carton with no lines behaves
-- exactly as it does now.
--
-- Where lines exist, `cartons.qty` becomes their sum — recomputed on write — so
-- the PACKED ledger, the funnel and the dashboard keep reading one number and
-- cannot disagree with the breakdown.

-- CreateTable
CREATE TABLE "carton_lines" (
    "id" TEXT NOT NULL,
    "cartonId" TEXT NOT NULL,
    "orderSizeId" TEXT,
    "sizeLabel" TEXT,
    "qty" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "carton_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carton_lines_cartonId_idx" ON "carton_lines"("cartonId");

-- AddForeignKey
ALTER TABLE "carton_lines" ADD CONSTRAINT "carton_lines_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "cartons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carton_lines" ADD CONSTRAINT "carton_lines_orderSizeId_fkey" FOREIGN KEY ("orderSizeId") REFERENCES "order_sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

