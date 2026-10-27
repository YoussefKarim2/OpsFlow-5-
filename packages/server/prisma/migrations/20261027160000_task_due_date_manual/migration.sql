-- Whether a task's due date was set by hand. Re-planning after the order's
-- dates move leaves those alone. Nullable, no default: every existing task
-- reads as "never edited", which is what is known about them.
ALTER TABLE "tasks" ADD COLUMN "dueDateManual" BOOLEAN;
