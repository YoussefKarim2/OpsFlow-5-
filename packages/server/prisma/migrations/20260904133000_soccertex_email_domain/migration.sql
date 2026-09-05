-- Move every account onto the only mail domain that exists.
--
-- The seed shipped thirteen accounts on `@age-factory.com`, a domain the
-- company does not own. Microsoft Graph accepted every notification addressed
-- to one of them — the queue duly recorded 140 rows as SENT — and Exchange then
-- bounced each one to the sender mailbox, which is why a change that was
-- announced correctly still reached nobody. A message that cannot be delivered
-- is not a mail-queue problem, so nothing in the queue could ever have caught
-- this; the addresses themselves were wrong.
--
-- Local parts are kept as they are: `abdo@age-factory.com` becomes
-- `abdo@soccertex.biz`, which is the same person at the address that exists.

-- 1. The accounts.
--
-- `email` is unique, so a rewrite that collided with an existing row would
-- abort the whole deploy. The NOT EXISTS guard makes this a no-op for any
-- address already taken (`ahmed@soccertex.biz` and `laila@soccertex.biz`, the
-- two super admins, are already on the new domain) rather than a failure, and
-- makes the migration safe to run against a database somebody has already
-- fixed by hand.
UPDATE "users" u
   SET "email" = replace(u."email", '@age-factory.com', '@soccertex.biz')
 WHERE u."email" LIKE '%@age-factory.com'
   AND NOT EXISTS (
     SELECT 1 FROM "users" x
      WHERE x."email" = replace(u."email", '@age-factory.com', '@soccertex.biz')
   );

-- 2. The mail still waiting to go out.
--
-- Only PENDING rows. A SENT row is a record of what was actually sent, to the
-- address it was actually sent to, and rewriting it would be falsifying the
-- delivery log to make it agree with a decision taken afterwards.
UPDATE "email_deliveries"
   SET "recipients" = ARRAY(
     SELECT replace(r, '@age-factory.com', '@soccertex.biz')
       FROM unnest("recipients") AS r
   )
 WHERE "status" = 'PENDING'
   AND EXISTS (SELECT 1 FROM unnest("recipients") AS r WHERE r LIKE '%@age-factory.com');

-- 3. Un-park anything held past the end of the retry schedule.
--
-- The longest real backoff is ten hours (see backoff.ts), so a PENDING row due
-- more than thirty days out was parked by hand during email testing and would
-- otherwise sit in the queue until the next century. Bringing it forward to now
-- puts it in the next drain pass.
UPDATE "email_deliveries"
   SET "nextAttemptAt" = CURRENT_TIMESTAMP
 WHERE "status" = 'PENDING'
   AND "nextAttemptAt" > CURRENT_TIMESTAMP + INTERVAL '30 days';
