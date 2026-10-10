-- Reservations become requests that a named person accepts or rejects.
-- Additive only: two new states and three nullable columns. Every existing
-- reservation keeps its state, and nothing is rewritten.
ALTER TYPE "ReservationStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "ReservationStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "material_reservations"
  ADD COLUMN "decidedById" TEXT,
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "decisionNote" TEXT;

ALTER TABLE "material_reservations"
  ADD CONSTRAINT "material_reservations_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
