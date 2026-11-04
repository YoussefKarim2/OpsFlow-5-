-- The uploaded file's checksum, so a sheet imported twice is noticed.
ALTER TABLE "import_jobs" ADD COLUMN "checksum" TEXT;
