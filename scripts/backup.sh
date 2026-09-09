#!/usr/bin/env bash
#
# Take an encrypted, offsite backup of the OpsFlow database.
#
# Runs nightly from .github/workflows/backup.yml, and by hand whenever you want
# a copy before doing something risky:
#
#   DATABASE_URL=... BACKUP_PASSPHRASE=... S3_BUCKET=... ./scripts/backup.sh
#
# The dump is compressed, then encrypted with AES-256 BEFORE it leaves this
# machine, so the bucket only ever holds ciphertext. Whoever holds the bucket
# cannot read the factory's orders; whoever holds the passphrase and not the
# bucket has nothing to read.
#
# Restoring is scripts/restore.sh. A backup nobody has restored is a guess —
# see docs/DISASTER-RECOVERY.md.

set -euo pipefail

# ── What we need ─────────────────────────────────────────────────────────────
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required — without it the backup cannot be read back}"
: "${S3_BUCKET:?S3_BUCKET is required (bucket name only, no s3:// prefix)}"

# Anything S3-compatible. Cloudflare R2, Backblaze B2 and Wasabi all work here;
# the point of an endpoint override is that the backup does not have to live at
# the same company as the database.
S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_PREFIX="${S3_PREFIX:-opsflow}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

aws_s3() {
  if [ -n "$S3_ENDPOINT" ]; then aws --endpoint-url "$S3_ENDPOINT" s3 "$@"
  else aws s3 "$@"; fi
}
aws_s3api() {
  if [ -n "$S3_ENDPOINT" ]; then aws --endpoint-url "$S3_ENDPOINT" s3api "$@"
  else aws s3api "$@"; fi
}

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
NAME="opsflow-${STAMP}.sql.gz.enc"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DUMP="$WORK/$NAME"

echo "→ dumping database"
# --no-owner/--no-acl so the dump restores into a database with different role
# names, which is exactly the situation you are in during a real recovery.
pg_dump "$DATABASE_URL" --no-owner --no-acl --format=plain \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass env:BACKUP_PASSPHRASE -out "$DUMP"

SIZE="$(wc -c < "$DUMP" | tr -d ' ')"
echo "  ${NAME}  ${SIZE} bytes"

# A dump that is suspiciously small usually means pg_dump failed into a pipe and
# the exit status was swallowed. Refuse to upload it and refuse to prune behind
# it — a tiny "successful" backup that evicts good ones is worse than no backup.
if [ "$SIZE" -lt 2048 ]; then
  echo "✗ dump is only ${SIZE} bytes — refusing to upload or prune." >&2
  exit 1
fi

echo "→ verifying it decrypts and is a real dump"
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -pass env:BACKUP_PASSPHRASE -in "$DUMP" \
    | gunzip \
    | head -c 4096 \
    | grep -q "PostgreSQL database dump"; then
  echo "✗ the encrypted file did not decrypt into a PostgreSQL dump." >&2
  exit 1
fi

echo "→ uploading to s3://${S3_BUCKET}/${S3_PREFIX}/"
aws_s3 cp "$DUMP" "s3://${S3_BUCKET}/${S3_PREFIX}/${NAME}"

echo "→ pruning backups older than ${RETAIN_DAYS} days"
CUTOFF="$(date -u -d "${RETAIN_DAYS} days ago" +%Y-%m-%d 2>/dev/null \
  || date -u -v-"${RETAIN_DAYS}"d +%Y-%m-%d)"
aws_s3api list-objects-v2 \
    --bucket "$S3_BUCKET" --prefix "${S3_PREFIX}/" \
    --query "Contents[?LastModified<='${CUTOFF}'].Key" --output text 2>/dev/null \
  | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' \
  | while read -r key; do
      echo "  removing ${key}"
      aws_s3 rm "s3://${S3_BUCKET}/${key}"
    done || true

echo "✓ backup complete: ${NAME}"
