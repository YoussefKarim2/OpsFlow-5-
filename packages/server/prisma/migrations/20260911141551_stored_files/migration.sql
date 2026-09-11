-- Uploaded files, stored in the database.
--
-- The API container has no mounted volume, so the local-disk storage driver was
-- writing attachments to a filesystem that is destroyed on every deploy. The
-- Attachment rows survived; the bytes they pointed at did not. This table gives
-- uploads the same durability as the rest of the data, and puts them inside the
-- backups rather than beside them.

CREATE TABLE "stored_files" (
    "key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "stored_files_createdAt_idx" ON "stored_files"("createdAt");
