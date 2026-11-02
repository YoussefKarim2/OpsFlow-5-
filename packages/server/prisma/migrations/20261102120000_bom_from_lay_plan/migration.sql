-- Bill-of-materials lines written from the Laying & Marking plan's fabric.
ALTER TABLE "bom_items" ADD COLUMN "fromLayPlan" BOOLEAN NOT NULL DEFAULT false;
