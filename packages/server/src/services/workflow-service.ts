/**
 * Workflow materialisation and task transitions.
 *
 * When an order is created, the 27 rows of `Progress Status` become 27 real
 * tasks with owners and due dates. That is the moment the workbook's process
 * definition stops being documentation and starts being the system.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  WORKFLOW_TEMPLATE, STAGE_META, DEPARTMENT_LABEL, planDueDate,
  type StageKey, type Department,
} from '@opsflow/shared';
import { assertTaskCompletable } from './rules.js';
import { logActivity, notify, recipientsFor } from './activity-service.js';
import { ConflictError, NotFoundError } from '../errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Create the 17 stages and 27 tasks for a new order.
 *
 * Assignment strategy: a task goes to the order's coordinator if it belongs to
 * the coordinator, to the named outside-work manager for external operations,
 * and otherwise to the least-loaded active user in the responsible department.
 * Unassigned is a last resort — an unowned task is a task nobody does.
 */
export async function materialiseWorkflow(
  db: Db,
  orderId: string,
  opts: {
    poDate: Date;
    promisedShippingDate: Date;
    coordinatorId?: string | null;
    outsideWorkManagerId?: string | null;
  },
): Promise<{ stagesCreated: number; tasksCreated: number }> {
  const stageKeys = Object.keys(STAGE_META) as StageKey[];

  await db.orderStage.createMany({
    data: stageKeys.map((stageKey) => ({ orderId, stageKey })),
    skipDuplicates: true,
  });

  const stages = await db.orderStage.findMany({ where: { orderId } });
  const stageIdByKey = new Map(stages.map((s) => [s.stageKey as StageKey, s.id]));

  const assignees = await resolveAssignees(db, opts);

  const templates = await db.taskTemplate.findMany({ where: { active: true }, orderBy: { position: 'asc' } });
  const source = templates.length > 0 ? templates : WORKFLOW_TEMPLATE;

  const created: Array<{ key: string; id: string; sequence: number }> = [];

  for (const t of source) {
    const orderStageId = stageIdByKey.get(t.stageKey as StageKey);
    if (!orderStageId) continue;

    const task = await db.task.create({
      data: {
        orderId,
        orderStageId,
        stageKey: t.stageKey as StageKey,
        templateKey: 'key' in t ? (t.key as string) : null,
        title: t.title,
        requirementEn: t.requirementEn,
        requirementAr: t.requirementAr,
        department: t.department as Department,
        sequence: t.sequence,
        estimatedMinutes: t.estimatedMinutes,
        priority: t.priority,
        dueDate: planDueDate(t.sequence, opts.poDate, opts.promisedShippingDate),
        assigneeId: assignees.get(t.department as Department) ?? null,
        status: 'NOT_STARTED',
      },
    });
    created.push({ key: ('key' in t ? (t.key as string) : task.id), id: task.id, sequence: t.sequence });
  }

  // Wire the sequence dependencies: each task is blocked by the last task of
  // the previous sequence group. This is Progress Status column I, made real.
  const bySequence = new Map<number, string[]>();
  for (const c of created) {
    const arr = bySequence.get(c.sequence) ?? [];
    arr.push(c.id);
    bySequence.set(c.sequence, arr);
  }
  const sequences = [...bySequence.keys()].sort((a, b) => a - b);

  for (let i = 1; i < sequences.length; i++) {
    const prevGroup = bySequence.get(sequences[i - 1]!) ?? [];
    const thisGroup = bySequence.get(sequences[i]!) ?? [];
    const blocker = prevGroup.at(-1);
    if (!blocker) continue;
    await db.task.updateMany({
      where: { id: { in: thisGroup } },
      data: { blockedByTaskId: blocker },
    });
  }

  return { stagesCreated: stageKeys.length, tasksCreated: created.length };
}

/** Pick an owner per department: named people first, then the least loaded. */
async function resolveAssignees(
  db: Db,
  opts: { coordinatorId?: string | null; outsideWorkManagerId?: string | null },
): Promise<Map<Department, string>> {
  const map = new Map<Department, string>();

  if (opts.coordinatorId) map.set('COORDINATOR' as Department, opts.coordinatorId);
  if (opts.outsideWorkManagerId) map.set('EXTERNAL_OPS' as Department, opts.outsideWorkManagerId);

  const departments = [...new Set(WORKFLOW_TEMPLATE.map((t) => t.department))] as Department[];
  const needed = departments.filter((d) => !map.has(d));
  if (needed.length === 0) return map;

  const users = await db.user.findMany({
    where: { department: { in: needed }, active: true },
    select: { id: true, department: true, _count: { select: { assignedTasks: { where: { status: { not: 'COMPLETED' } } } } } },
  });

  for (const dept of needed) {
    const candidates = users
      .filter((u) => u.department === dept)
      .sort((a, b) => a._count.assignedTasks - b._count.assignedTasks);
    const pick = candidates[0];
    if (pick) map.set(dept, pick.id);
  }

  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Following the order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The departments whose tasks belong to a person named on the order, by the
 * order field that names them — the same two `resolveAssignees` honours.
 */
export const NAMED_OWNER_DEPARTMENT = {
  coordinatorId: 'COORDINATOR',
  outsideWorkManagerId: 'EXTERNAL_OPS',
} as const satisfies Record<string, Department>;

/**
 * Hand a department's open tasks from the person who was named on the order
 * to the person named now.
 *
 * The tasks were assigned once, when the order was created, and changing the
 * coordinator afterwards left every coordinator task with the old one: the new
 * owner saw nothing in My Tasks, the old one kept being chased. Only tasks
 * still with the old person move — one somebody reassigned by hand has an
 * owner chosen on purpose — and completed tasks keep who did them. Clearing
 * the name moves nothing: an unowned task is a task nobody does.
 */
export async function reassignOpenTasks(
  db: Db,
  opts: { orderId: string; department: Department; fromId: string | null; toId: string | null },
): Promise<number> {
  if (!opts.toId || opts.fromId === opts.toId) return 0;
  // `updateMany`, which the audit middleware does not intercept: one activity
  // line from the caller says it, rather than an announcement per task.
  const moved = await db.task.updateMany({
    where: {
      orderId: opts.orderId,
      department: opts.department,
      status: { not: 'COMPLETED' },
      assigneeId: opts.fromId,
    },
    data: { assigneeId: opts.toId },
  });
  return moved.count;
}

/**
 * Re-plan the due dates of an order's open tasks after its dates moved.
 *
 * The schedule is spread between the PO date and the promised shipping date
 * (`planDueDate`), and was worked out once, at creation. Moving either date
 * left every task on the old plan — overdue against a shipping date that had
 * been pushed back, or comfortable against one brought forward. A due date
 * somebody set by hand is theirs and is left alone, as are completed tasks
 * and corrective actions, which are due the day after the failed audit rather
 * than on the plan. Returns how many tasks moved.
 */
export async function replanTaskDueDates(
  db: Db,
  opts: { orderId: string; poDate: Date; promisedShippingDate: Date },
): Promise<number> {
  const tasks = await db.task.findMany({
    where: {
      orderId: opts.orderId,
      status: { not: 'COMPLETED' },
      isCorrectiveAction: false,
      // Null is "never edited by hand" — every task from before the flag.
      OR: [{ dueDateManual: null }, { dueDateManual: false }],
    },
    select: { id: true, sequence: true, dueDate: true },
  });

  // One write per sequence group, since every task in a group shares a date.
  const bySequence = new Map<number, { due: Date; ids: string[] }>();
  for (const t of tasks) {
    const due = planDueDate(t.sequence, opts.poDate, opts.promisedShippingDate);
    if (t.dueDate?.getTime() === due.getTime()) continue;
    const group = bySequence.get(t.sequence) ?? { due, ids: [] };
    group.ids.push(t.id);
    bySequence.set(t.sequence, group);
  }

  let moved = 0;
  for (const { due, ids } of bySequence.values()) {
    const r = await db.task.updateMany({ where: { id: { in: ids } }, data: { dueDate: due } });
    moved += r.count;
  }
  return moved;
}

/**
 * Whether this person may work a task — start it or complete it: its
 * assignee, anyone in the responsible department, or anyone who can assign
 * tasks (coordinator, admin).
 */
export function mayWorkTask(
  task: { assigneeId: string | null; department: string },
  actor: { id: string; department: string | null; permissions: readonly string[] },
): boolean {
  return task.assigneeId === actor.id
    || task.department === actor.department
    || actor.permissions.includes('task:assign');
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

export interface CompleteTaskInput {
  taskId: string;
  actorId: string;
  actorName: string;
  notes?: string | null;
  actualMinutes?: number | null;
}

const ALREADY_COMPLETED = 'This task is already completed.';

export async function completeTask(db: PrismaClient, input: CompleteTaskInput) {
  const task = await db.task.findUnique({
    where: { id: input.taskId },
    include: { order: { select: { id: true, poNumber: true, coordinatorId: true } } },
  });
  if (!task) throw new NotFoundError('Task');
  if (task.status === 'COMPLETED') throw new ConflictError(ALREADY_COMPLETED);

  // Refuses if the prerequisite information is missing — see rules.ts.
  await assertTaskCompletable(db, task);

  // One transaction, so a corrective-action task can never be marked done while
  // the audit it answers still says its corrective action is open.
  return db.$transaction(async (tx) => {
    // Completing is done once. Two people pressing Complete together (or one
    // double click) both passed the check above, and the second completion
    // re-ran everything below: a second activity line, the next group told
    // twice that it was their turn. Under the task's row lock the status is
    // read again, so only the first one through does any of it. The write
    // stays an `update` so the audit trail still records the completion.
    await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${task.id} FOR UPDATE`;
    const current = await tx.task.findUnique({ where: { id: task.id }, select: { status: true } });
    if (!current) throw new NotFoundError('Task');
    if (current.status === 'COMPLETED') throw new ConflictError(ALREADY_COMPLETED);

    const updated = await tx.task.update({
      where: { id: task.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        completedById: input.actorId,
        notes: input.notes ?? task.notes,
        actualMinutes: input.actualMinutes ?? task.actualMinutes,
        startedAt: task.startedAt ?? new Date(),
      },
    });

    await logActivity({
      orderId: task.orderId,
      actorId: input.actorId,
      actorName: input.actorName,
      action: 'TASK_COMPLETED',
      summary: `completed "${task.title}"`,
      entityType: 'Task',
      entityId: task.id,
      meta: { stageKey: task.stageKey, department: task.department },
    }, tx);

    // Completing the corrective-action task *is* closing the corrective
    // action. Without this the task list said done while the audit stayed
    // open, and the order sat Quality Blocked with nothing left to click but a
    // second button on another tab. Mirrors the Quality tab's close route.
    if (task.sourceAuditId) {
      const closed = await tx.qualityAudit.updateMany({
        where: { id: task.sourceAuditId, correctiveActionClosed: false },
        data: { correctiveActionClosed: true },
      });
      if (closed.count > 0) {
        await logActivity({
          orderId: task.orderId, actorId: input.actorId, actorName: input.actorName,
          action: 'CORRECTIVE_ACTION_CLOSED',
          summary: 'closed the corrective action — the order is no longer quality-blocked',
          entityType: 'QualityAudit', entityId: task.sourceAuditId,
        }, tx);
      }
    }

    // Unblock whatever was waiting on this task's sequence group.
    await unblockDependents(tx, task.orderId, task.sequence);

    // Tell the next group's owners that they are up.
    await notifyNextGroup(tx, task.orderId, task.sequence, input.actorId);

    return updated;
  });
}

/**
 * A task's dependents become workable once every task in its sequence group is
 * done — not merely this one. Releasing early is how a factory ends up cutting
 * before the marker is approved.
 */
async function unblockDependents(db: Db, orderId: string, sequence: number): Promise<void> {
  const groupOutstanding = await db.task.count({
    where: { orderId, sequence, status: { not: 'COMPLETED' } },
  });
  if (groupOutstanding > 0) return;

  await db.task.updateMany({
    where: { orderId, sequence: sequence + 1, status: 'BLOCKED' },
    data: { status: 'NOT_STARTED', blockedReason: null },
  });
}

async function notifyNextGroup(
  db: Db, orderId: string, sequence: number, actorId: string,
): Promise<void> {
  const outstanding = await db.task.count({
    where: { orderId, sequence, status: { not: 'COMPLETED' } },
  });
  if (outstanding > 0) return;

  const next = await db.task.findMany({
    where: { orderId, sequence: sequence + 1, status: { not: 'COMPLETED' } },
    include: { order: { select: { poNumber: true, orderName: true } } },
  });
  if (next.length === 0) return;

  const order = next[0]!.order;
  for (const t of next) {
    if (!t.assigneeId || t.assigneeId === actorId) continue;
    await notify({
      userIds: [t.assigneeId],
      orderId,
      type: 'TASK_ASSIGNED',
      title: `Your turn on ${order.poNumber}`,
      body: `${t.title} — ${DEPARTMENT_LABEL[t.department as Department].en}`,
      link: `/orders/${orderId}?tab=tasks&task=${t.id}`,
    }, db);
  }
}

/**
 * Start a task. A completed task is not started again: that put it back to
 * In progress while it kept its completion date and who completed it, so it
 * read as done and not done at once. Reopening is its own action.
 */
export async function startTask(db: PrismaClient, taskId: string, actorId: string, actorName: string) {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError('Task');
  if (task.status === 'COMPLETED') {
    throw new ConflictError('This task is already completed. Reopen it first if the work is not finished.');
  }

  const updated = await db.task.update({
    where: { id: taskId },
    data: { status: 'IN_PROGRESS', startedAt: task.startedAt ?? new Date() },
  });

  await logActivity({
    orderId: task.orderId, actorId, actorName,
    action: 'TASK_STARTED', summary: `started "${task.title}"`,
    entityType: 'Task', entityId: task.id,
  }, db);

  return updated;
}

export async function assignTask(
  db: PrismaClient, taskId: string, assigneeId: string | null, actorId: string, actorName: string,
) {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError('Task');

  const assignee = assigneeId
    ? await db.user.findUnique({ where: { id: assigneeId }, select: { id: true, name: true } })
    : null;
  if (assigneeId && !assignee) throw new NotFoundError('User');

  const updated = await db.task.update({ where: { id: taskId }, data: { assigneeId } });

  await logActivity({
    orderId: task.orderId, actorId, actorName,
    action: 'TASK_ASSIGNED',
    summary: assignee ? `assigned "${task.title}" to ${assignee.name}` : `unassigned "${task.title}"`,
    entityType: 'Task', entityId: task.id,
  }, db);

  if (assignee && assignee.id !== actorId) {
    const order = await db.order.findUnique({ where: { id: task.orderId }, select: { poNumber: true } });
    await notify({
      userIds: [assignee.id], orderId: task.orderId, type: 'TASK_ASSIGNED',
      title: `Task assigned on ${order?.poNumber ?? 'an order'}`,
      body: task.title,
      link: `/orders/${task.orderId}?tab=tasks&task=${task.id}`,
    }, db);
  }

  return updated;
}

/**
 * Auto-create the corrective-action task a failed audit demands — the brief's
 * section 22. It goes to the production manager, due tomorrow, and blocks the
 * order until closed.
 */
export async function createCorrectiveActionTask(
  db: Db,
  opts: { orderId: string; auditId: string; body: string; actorId: string; actorName: string },
) {
  const stage = await db.orderStage.findFirst({
    where: { orderId: opts.orderId, stageKey: 'AUDIT' },
  });
  if (!stage) throw new NotFoundError('Audit stage');

  const owner = await db.user.findFirst({
    where: { department: 'PRODUCTION_MANAGER', active: true },
    select: { id: true },
  });

  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 1);

  const task = await db.task.create({
    data: {
      orderId: opts.orderId,
      orderStageId: stage.id,
      stageKey: 'AUDIT',
      title: 'Corrective action for failed quality audit',
      requirementEn: opts.body,
      department: 'PRODUCTION_MANAGER',
      sequence: 12,
      priority: 'URGENT',
      status: 'NOT_STARTED',
      dueDate: due,
      assigneeId: owner?.id ?? null,
      isCorrectiveAction: true,
      sourceAuditId: opts.auditId,
    },
  });

  const userIds = await recipientsFor(opts.orderId, ['PRODUCTION_MANAGER', 'FACTORY_MANAGER'], db);
  await notify({
    userIds, orderId: opts.orderId, type: 'QUALITY_FAILURE',
    title: 'Quality audit failed — corrective action required',
    body: opts.body.split('\n')[0] ?? '',
    link: `/orders/${opts.orderId}?tab=quality`,
  }, db);

  return task;
}
