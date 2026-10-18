-- Proforma / Invoice.
--
-- Three new tables and three enums, all additive. `company_profile` is the
-- factory's own letterhead and bank details (one row, created on first read);
-- `invoices` and `invoice_lines` are the documents, numbered per kind and year
-- under a unique index so two drafts created at once cannot share a number.
-- Nothing existing is touched: the step-4 proforma (`proforma_invoices`) stays
-- as it is.

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('PROFORMA', 'INVOICE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceLineKind" AS ENUM ('ITEM', 'EXTRA');

-- CreateTable
CREATE TABLE "company_profile" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT 'Soccertex',
    "tagline" TEXT,
    "address" TEXT,
    "taxId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "bankDetails" TEXT,
    "invoiceTerms" TEXT,
    "paymentTerms" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "packingListId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "paymentTerms" TEXT,
    "billTo" TEXT NOT NULL,
    "billToAddress" TEXT,
    "billToEmail" TEXT,
    "customerReference" TEXT,
    "shipmentRef" TEXT,
    "shippedOn" TIMESTAMP(3),
    "coverNote" TEXT,
    "terms" TEXT,
    "bankDetails" TEXT,
    "notes" TEXT,
    "seller" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "reconciliation" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedAt" TIMESTAMP(3),
    "issuedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "preparedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "InvoiceLineKind" NOT NULL DEFAULT 'ITEM',
    "description" TEXT NOT NULL,
    "size" TEXT,
    "quantity" DECIMAL(14,4),
    "unitPrice" DECIMAL(14,6),
    "amount" DECIMAL(14,2),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_orderId_idx" ON "invoices"("orderId");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_kind_year_sequence_key" ON "invoices"("kind", "year", "sequence");

-- CreateIndex
CREATE INDEX "invoice_lines_invoiceId_idx" ON "invoice_lines"("invoiceId");

-- AddForeignKey
ALTER TABLE "company_profile" ADD CONSTRAINT "company_profile_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_packingListId_fkey" FOREIGN KEY ("packingListId") REFERENCES "packing_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Permissions.
--
-- A live request is authorised against `roles.permissions` in this database,
-- not against the TypeScript table (see the laying_import_permission migration
-- for the reasoning), so the three new permissions are granted here to match
-- `ROLE_PERMISSIONS` in the shared package. Guarded on the array's contents, so
-- a second run makes no further change.
--
-- Reading and drafting: the administrators, both coordinator roles and Finance.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'invoice:read')
 WHERE "key" IN ('SUPER_ADMIN', 'ADMIN', 'LEAD_COORDINATOR', 'COORDINATOR', 'FINANCE')
   AND NOT ('invoice:read' = ANY ("permissions"));

UPDATE "roles"
   SET "permissions" = array_append("permissions", 'invoice:write')
 WHERE "key" IN ('SUPER_ADMIN', 'ADMIN', 'LEAD_COORDINATOR', 'COORDINATOR', 'FINANCE')
   AND NOT ('invoice:write' = ANY ("permissions"));

-- Issuing and voiding — the act with financial consequence — is not given to
-- the order coordinator.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'invoice:issue')
 WHERE "key" IN ('SUPER_ADMIN', 'ADMIN', 'LEAD_COORDINATOR', 'FINANCE')
   AND NOT ('invoice:issue' = ANY ("permissions"));
