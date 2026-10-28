-- The exporter block and signature on every document: QIZ reference, signatory, company stamp.
ALTER TABLE "company_profile" ADD COLUMN "qizRef" TEXT, ADD COLUMN "signatory" TEXT, ADD COLUMN "stampDataUrl" TEXT;
