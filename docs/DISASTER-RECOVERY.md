# Disaster recovery

What can be lost, what protects it, and exactly what to do when something has
already gone wrong.

Read the first section now, not during an incident.

---

## Set this up (once, ~30 minutes)

Nothing below works until these are done. The backup workflow is committed but
it **cannot run without the secrets**, and it will fail every night until they
exist.

### 1. Check where uploaded files are going — do this first

`STORAGE_DRIVER` defaults to `local`, which writes attachments to `./.storage`
inside the container. **Railway's filesystem is ephemeral: every deploy wipes
it.** If production is still on `local`, every customer PO, artwork file and
document uploaded so far is already gone, and more will go with the next push.

In the Railway dashboard → your service → Variables, confirm:

```
STORAGE_DRIVER = s3
S3_BUCKET      = <a bucket>
S3_ENDPOINT    = <if using R2 / B2 / Wasabi>
S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
```

The S3 driver is already written (`packages/server/src/services/storage/s3-driver.ts`)
— this is configuration, not code. Alternatively mount a Railway volume at the
`STORAGE_LOCAL_DIR` path, but object storage is the better answer.

**The database backups in this document do not cover uploaded files.** They are
separate systems and need separate protection.

### 2. Create a bucket for backups — somewhere that is not Railway

The whole point is that it survives losing the Railway account. Cloudflare R2,
Backblaze B2 and Wasabi are all S3-compatible and cost pennies at this size.

Create a bucket and an access key **scoped to that bucket only**.

### 3. Add the GitHub secrets

Repository → Settings → Secrets and variables → Actions → *Secrets*:

| Secret | What |
|---|---|
| `DATABASE_URL` | Production connection string, from Railway → Postgres → Connect |
| `BACKUP_PASSPHRASE` | Long random string: `openssl rand -base64 48` |
| `S3_BUCKET` | Bucket name only, no `s3://` |
| `AWS_ACCESS_KEY_ID` | The scoped key |
| `AWS_SECRET_ACCESS_KEY` | Its secret |

And under *Variables*, if you are not on AWS proper:

| Variable | Example |
|---|---|
| `S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` |
| `AWS_REGION` | `auto` |
| `RETAIN_DAYS` | `30` |

> **`BACKUP_PASSPHRASE` is the one thing that cannot be recovered.** Every backup
> is encrypted with it before leaving GitHub. Lose it and the backups are
> permanently unreadable — they become noise. Put it in a password manager, and
> make sure a second person in the company can reach it.

### 4. Run it once by hand

Actions → *Nightly database backup* → **Run workflow**. Confirm it goes green
and the object appears in the bucket. It then runs itself at 02:00 UTC.

### 5. Turn on Railway's own Postgres backups

Railway → Postgres → Settings. Use them as well, not instead: they are fast to
restore from but live in the same account as the thing they protect.

### 6. Add uptime monitoring

Point any free monitor (UptimeRobot, Better Stack) at:

```
https://opsflow-api-production.up.railway.app/api/health
```

so an outage reaches you as a notification rather than a phone call from the
factory floor.

---

## Restoring

### List what you have

```bash
export BACKUP_PASSPHRASE=…  S3_BUCKET=…  S3_ENDPOINT=…
./scripts/restore.sh --list
```

### Restore into a scratch database first

Always. Even when production is down — you want to know the backup is good
before you drop anything.

```bash
export TARGET_DATABASE_URL=postgresql://…/opsflow_recovery
./scripts/restore.sh opsflow-2026-09-09T02-00-00Z.sql.gz.enc
```

The script asks you to type the target host name before it touches anything,
and it prints row counts afterwards. If those counts look wrong, stop and try an
older backup.

### Then point the app at it

Change `DATABASE_URL` in the Railway dashboard to the recovered database and
redeploy. Doing it this way — rather than restoring over the live database —
means the damaged one is still there if you need to pull something out of it.

---

## When the worst has happened

**Someone deleted or corrupted data, and the app is otherwise fine.**
Do not restore over production. Restore last night's backup into a scratch
database, find the rows you need, and copy them across. `activity_logs` and
`audit_trails` will tell you who changed what and when, which usually narrows it
to a handful of rows.

**The database is gone or unreachable.**
Create a new Postgres instance, restore the newest backup into it, point
`DATABASE_URL` at it, redeploy. Expect to lose up to 24 hours — that is the gap
between nightly backups. If that is too much, raise the cron frequency in
`.github/workflows/backup.yml`, or turn on point-in-time recovery at Railway.

**A migration failed and the site will not start.**
`railpack.json` runs `prisma migrate deploy` before the server starts, so a bad
migration takes the whole site down rather than just failing quietly. Revert the
offending commit and push — that redeploys the previous schema. If the migration
half-applied, restore from backup instead; a partially-migrated database is not
worth repairing by hand under pressure.

**The Railway account is lost.**
This is the case the offsite bucket exists for. Deploy the repository anywhere
that runs Node and Postgres, restore the newest backup, set the environment
variables. Nothing in this system is Railway-specific except the dashboard.

---

## Keep it honest

**Restore a backup every quarter.** A backup nobody has restored is a guess. It
takes ten minutes: restore the newest into a scratch database, check the row
counts, drop it.

**Watch for failures.** The workflow writes a loud failure summary, but nobody
reads a page they do not visit — GitHub emails you on a failed scheduled run, so
make sure that address is one you actually read.

**Test the passphrase, not just the file.** Restoring proves both. Downloading
proves neither.

---

## What is protected, and what is not

| | Protected by |
|---|---|
| Database — orders, quantities, users, BOM, audit trail | Nightly encrypted offsite backup + Railway backups |
| Accidental seed against production | `assertSafeToSeed` — the seed refuses any non-local database |
| Uploaded files and attachments | **Nothing, until `STORAGE_DRIVER=s3` is set.** See step 1 |
| Up to 24h of recent changes | **Not covered** — nightly is nightly. Raise the frequency or enable PITR |
| Bad migration on deploy | Revert and redeploy, or restore. Not prevented |
| A single Railway instance crashing | Railway restarts it. There is no second instance |
