-- Remove the Follow-up stage from the process.
--
-- Its two checklist tasks and its four readiness gates were not deleted with
-- it: the jobs still exist and somebody still does them, so they moved to
-- Production, where they actually happen. What goes here is only the stage
-- itself and the rows that exist solely to represent it on an order.
--
-- Postgres cannot drop a value from an enum, so the type is rebuilt without it.
-- Every column that uses StageKey is swapped over in one transaction; the
-- defaults are dropped first because a default referencing the old type blocks
-- the swap, and are put back afterwards.
--
-- Note the Department enum also has a FOLLOW_UP value — the Follow-up Officer
-- role — and is deliberately untouched. People hold that job.

-- 1. The checklist rows move rather than die.
--
-- Task templates are what every new order's task list is built from — the
-- service reads them from here in preference to the constant in code — so
-- deleting these two would quietly drop "enter the daily order detail" and
-- "track the order and escalate deviations" from every order created after
-- this migration. The jobs did not stop existing when the tab did.
UPDATE "task_templates" SET "stageKey" = 'PRODUCTION_FOLLOW_UP' WHERE "stageKey" = 'FOLLOW_UP';
UPDATE "tasks"          SET "stageKey" = 'PRODUCTION_FOLLOW_UP',
                            "orderStageId" = (
                              SELECT os."id" FROM "order_stages" os
                               WHERE os."orderId" = "tasks"."orderId"
                                 AND os."stageKey" = 'PRODUCTION_FOLLOW_UP'
                            )
 WHERE "stageKey" = 'FOLLOW_UP';

-- 2. The stage row itself has nothing left to represent.
DELETE FROM "order_stages" WHERE "stageKey" = 'FOLLOW_UP';

-- 3. Columns that merely referenced it, where the row itself is still wanted.
UPDATE "attachments"        SET "stageKey" = NULL WHERE "stageKey" = 'FOLLOW_UP';
UPDATE "orders"             SET "cachedStageKey" = NULL WHERE "cachedStageKey" = 'FOLLOW_UP';
UPDATE "material_movements" SET "stage" = NULL WHERE "stage" = 'FOLLOW_UP';

-- 4. Rebuild the type without the value.
ALTER TYPE "StageKey" RENAME TO "StageKey_old";

CREATE TYPE "StageKey" AS ENUM (
  'CUSTOMER_ORDER_REF',
  'ORDER_DETAILS',
  'MAIN_ORDER',
  'PROGRESS_STATUS',
  'CUT_ORDER',
  'LAYING_FABRIC',
  'BILL_OF_MATERIAL',
  'CUSTOM_INSTRUCTIONS',
  'EXTERNAL_ORDER',
  'STOCK',
  'PRODUCTION_FOLLOW_UP',
  'PACKING',
  'AUDIT',
  'ACTUAL_COSTING',
  'DATABASE',
  'INVOICE',
  'COMPLETED',
  'PROFORMA_INVOICE'
);

ALTER TABLE "attachments"        ALTER COLUMN "stageKey" TYPE "StageKey" USING "stageKey"::text::"StageKey";
ALTER TABLE "material_movements" ALTER COLUMN "stage"    TYPE "StageKey" USING "stage"::text::"StageKey";
ALTER TABLE "order_stages"       ALTER COLUMN "stageKey" TYPE "StageKey" USING "stageKey"::text::"StageKey";
ALTER TABLE "orders"             ALTER COLUMN "cachedStageKey" TYPE "StageKey" USING "cachedStageKey"::text::"StageKey";
ALTER TABLE "task_templates"     ALTER COLUMN "stageKey" TYPE "StageKey" USING "stageKey"::text::"StageKey";
ALTER TABLE "tasks"              ALTER COLUMN "stageKey" TYPE "StageKey" USING "stageKey"::text::"StageKey";

DROP TYPE "StageKey_old";
