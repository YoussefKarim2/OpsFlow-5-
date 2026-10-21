-- One document can cover several orders: an order split into several POs is
-- invoiced on one proforma or invoice. Each order on a document keeps its own
-- packing list, shipment and identity snapshot here. Invoice.orderId and its
-- packing list / shipment columns stay as the first order, so every existing
-- document reads exactly as before; the back-fill gives each one its row.
-- CreateTable
CREATE TABLE "invoice_orders" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "packingListId" TEXT,
    "shipmentId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "orderRef" JSONB,

    CONSTRAINT "invoice_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_orders_orderId_idx" ON "invoice_orders"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_orders_invoiceId_orderId_key" ON "invoice_orders"("invoiceId", "orderId");

-- AddForeignKey
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_packingListId_fkey" FOREIGN KEY ("packingListId") REFERENCES "packing_lists"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_orders" ADD CONSTRAINT "invoice_orders_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Back-fill: every existing document covers its one order.
INSERT INTO "invoice_orders" ("id", "invoiceId", "orderId", "packingListId", "shipmentId", "position", "orderRef")
SELECT 'io_' || "id", "id", "orderId", "packingListId", "shipmentId", 0, "orderRef"
FROM "invoices";
