#!/usr/bin/env bash
#
# Restore an OpsFlow backup taken by scripts/backup.sh.
#
#   ./scripts/restore.sh --list
#   ./scripts/restore.sh opsflow-2026-09-09T02-00-00Z.sql.gz.enc
#
# Restores into TARGET_DATABASE_URL, which is deliberately a different variable
# from DATABASE_URL: the common case is restoring into a scratch database to
# check a backup is real, and defaulting that to the live one would be a way of
# destroying production with a recovery tool.
#
# The full procedure, including what to do when the live database is gone, is in
# docs/DISASTER-RECOVERY.md.

set -euo pipefail

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_PREFIX="${S3_PREFIX:-opsflow}"

aws_s3() {
  if [ -n "$S3_ENDPOINT" ]; then aws --endpoint-url "$S3_ENDPOINT" s3 "$@"
  else aws s3 "$@"; fi
}

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
  echo "Backups in s3://${S3_BUCKET}/${S3_PREFIX}/ (newest last):"
  aws_s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" | sort
  echo
  echo "Restore one with:  TARGET_DATABASE_URL=... $0 <name>"
  exit 0
fi

NAME="$1"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required — the database to restore INTO}"

HOST="$(node -e 'try{process.stdout.write(new URL(process.argv[1]).hostname)}catch{process.stdout.write("?")}' "$TARGET_DATABASE_URL" 2>/dev/null || echo '?')"

echo "About to restore"
echo "  backup : ${NAME}"
echo "  into   : ${HOST}"
echo
echo "This DROPS AND RECREATES the public schema on that database."
printf 'Type the host name to confirm: '
read -r CONFIRM
if [ "$CONFIRM" != "$HOST" ]; then
  echo "✗ "'"'"${CONFIRM}"'"'" does not match "'"'"${HOST}"'"'". Nothing was changed." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ downloading"
aws_s3 cp "s3://${S3_BUCKET}/${S3_PREFIX}/${NAME}" "$WORK/backup.enc"

echo "→ decrypting"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_PASSPHRASE -in "$WORK/backup.enc" | gunzip > "$WORK/backup.sql"

if ! head -c 4096 "$WORK/backup.sql" | grep -q "PostgreSQL database dump"; then
  echo "✗ that did not decrypt into a PostgreSQL dump — wrong passphrase?" >&2
  exit 1
fi
echo "  $(wc -l < "$WORK/backup.sql" | tr -d ' ') lines of SQL"

echo "→ resetting the target schema"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'

echo "→ restoring"
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$WORK/backup.sql"

echo "→ checking what came back"
psql "$TARGET_DATABASE_URL" -t -c \
  "select '  orders: ' || count(*) from orders
   union all select '  users: ' || count(*) from users
   union all select '  quantities: ' || count(*) from stage_quantities;" 2>/dev/null || true

echo "✓ restored ${NAME}"
