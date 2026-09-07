-- Manual entry alongside automatic population.
--
-- Purely additive: two new tables and four new nullable columns. Nothing is
-- dropped, no existing column changes type, and every existing row remains
-- valid — `cost_lines.source` defaults to MANUAL, which is the truth about
-- every line that exists today, since nothing derived them.
--
-- `bom_item_sizes` gives a BOM item a size breakdown it never had. The item's
-- `requiredQty` stays the total and is recomputed from these rows when any
-- exist, so the shortage arithmetic keeps reading one number.
--
-- `instruction_lines` is the name-and-number table that sits beside a custom
-- instruction's prose, not instead of it: `title` and `body` are untouched.

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('DERIVED', 'MANUAL');

-- AlterTable
ALTER TABLE "bom_items" ADD COLUMN     "supplier" TEXT,
ADD COLUMN     "unitPriceUsd" DECIMAL(14,6);

-- AlterTable
ALTER TABLE "cost_lines" ADD COLUMN     "note" TEXT,
ADD COLUMN     "source" "CostSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceRef" TEXT;

-- CreateTable
CREATE TABLE "bom_item_sizes" (
    "id" TEXT NOT NULL,
    "bomItemId" TEXT NOT NULL,
    "sizeLabel" TEXT NOT NULL,
    "qty" DECIMAL(14,4) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bom_item_sizes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruction_lines" (
    "id" TEXT NOT NULL,
    "instructionId" TEXT NOT NULL,
    "name" TEXT,
    "number" TEXT,
    "sizeLabel" TEXT,
    "qty" DECIMAL(14,4),
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "instruction_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bom_item_sizes_bomItemId_idx" ON "bom_item_sizes"("bomItemId");

-- CreateIndex
CREATE INDEX "instruction_lines_instructionId_idx" ON "instruction_lines"("instructionId");

-- AddForeignKey
ALTER TABLE "bom_item_sizes" ADD CONSTRAINT "bom_item_sizes_bomItemId_fkey" FOREIGN KEY ("bomItemId") REFERENCES "bom_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruction_lines" ADD CONSTRAINT "instruction_lines_instructionId_fkey" FOREIGN KEY ("instructionId") REFERENCES "custom_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

