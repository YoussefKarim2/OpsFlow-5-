-- AlterEnum
ALTER TYPE "RefKind" ADD VALUE 'SHIPPING_ADDRESS';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "internalPoDate" TIMESTAMP(3),
ADD COLUMN     "productionSample" BOOLEAN;

