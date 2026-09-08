-- Access to an order becomes an explicit grant.
--
-- Additive: a new table and nothing removed. `orders.coordinatorId` and
-- `orders.outsideWorkManagerId` stay exactly as they are — they are what the
-- notification routing means by "responsible for this order", which is a
-- different question from who may open it.
--
-- The backfill at the end is the important part. Enforcement without it would
-- make every existing order inaccessible to everybody but the administrators
-- the moment this deploys, which is an outage rather than a security
-- improvement. Anybody already named on an order keeps working on it.

-- CreateTable
CREATE TABLE "order_assignments" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_assignments_userId_idx" ON "order_assignments"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "order_assignments_orderId_userId_key" ON "order_assignments"("orderId", "userId");

-- AddForeignKey
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_assignments" ADD CONSTRAINT "order_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Everyone already named on an order is assigned to it.
--
-- Both roles, in one pass, ignoring duplicates: an order whose coordinator and
-- outside-work manager are the same person yields one row, not a constraint
-- violation. `assignedById` is null because nobody granted these — they are the
-- state that already existed, carried forward.
INSERT INTO "order_assignments" ("id", "orderId", "userId", "assignedById", "createdAt")
SELECT 'cl' || substr(md5(o."id" || ':' || u."id"), 1, 22), o."id", u."id", NULL, CURRENT_TIMESTAMP
  FROM "orders" o
  JOIN LATERAL (VALUES (o."coordinatorId"), (o."outsideWorkManagerId")) AS v("id") ON v."id" IS NOT NULL
  JOIN "users" u ON u."id" = v."id"
ON CONFLICT ("orderId", "userId") DO NOTHING;
