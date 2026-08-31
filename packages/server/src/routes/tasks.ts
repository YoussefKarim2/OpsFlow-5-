import { Router } from 'express';
import { z } from 'zod';
import { daysBetween, STAGE_META, DEPARTMENT_LABEL, type StageKey } from '@opsflow/shared';
import { prisma } from '../db.js';
import { authenticate, requirePermission, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../util/async-handler.js';
import { NotFoundError, ForbiddenError } from '../errors.js';
import { completeTask, startTask, assignTask } from '../services/workflow-service.js';
import { refreshOrderCache } from '../services/order-service.js';
import { logActivity } from '../services/activity-service.js';

export const tasksRouter = Router();
tasksRouter.use(authenticate);

const TASK_INCLUDE = {
  assignee: true,
  completedBy: true,
  order: { select: { id: true, poNumber: true, orderName: true, cancelled: true } },
  _count: { select: { comments: true, attachments: true } },
} as const;

function toDto(t: {
  id: string; stageKey: string; title: string; requirementEn: string | null; requirementAr: string | null;
  department: string; sequence: number; estimatedMinutes: number | null; status: string; priority: string;
  dueDate: Date | null; startedAt: Date | null; completedAt: Date | null; notes: string | null;
  blockedReason: string | null;
  assignee: { id: string; name: string } | null;
  completedBy: { id: string; name: string } | null;
  order: { id: string; poNumber: string; orderName: string };
  _count: { comments: number; attachments: number };
}, today = new Date()) {
  const daysRemaining = t.dueDate ? daysBetween(today, t.dueDate) : null;
  return {
    id: t.id,
    orderId: t.order.id,
    orderPoNumber: t.order.poNumber,
    orderName: t.order.orderName,
    stageKey: t.stageKey,
    stageLabel: STAGE_META[t.stageKey as StageKey]?.label ?? t.stageKey,
    title: t.title,
    requirementEn: t.requirementEn,
    requirementAr: t.requirementAr,
    department: t.department,
    departmentLabel: DEPARTMENT_LABEL[t.department as keyof typeof DEPARTMENT_LABEL]?.en ?? t.department,
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.name } : null,
    status: t.status,
    priority: t.priority,
    sequence: t.sequence,
    estimatedMinutes: t.estimatedMinutes,
    dueDate: t.dueDate?.toISOString() ?? null,
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    completedBy: t.completedBy ? { id: t.completedBy.id, name: t.completedBy.name } : null,
    notes: t.notes,
    attachmentCount: t._count.attachments,
    commentCount: t._count.comments,
    daysRemaining,
    isOverdue: t.status !== 'COMPLETED' && daysRemaining != null && daysRemaining < 0,
    blockedReason: t.blockedReason,
  };
}

/** My Tasks — everything assigned to me, or to my department if unassigned. */
tasksRouter.get('/mine', requirePermission('task:read'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const includeCompleted = req.query.includeCompleted === 'true';

  const tasks = await prisma.task.findMany({
    where: {
      order: { cancelled: false },
      ...(includeCompleted ? {} : { status: { not: 'COMPLETED' } }),
      OR: [
        { assigneeId: actor.id },
        { assigneeId: null, department: actor.department as never },
      ],
    },
    include: TASK_INCLUDE,
    orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }],
    take: 200,
  });

  res.json({ data: tasks.map((t) => toDto(t)) });
}));

tasksRouter.get('/', requirePermission('task:read'), asyncHandler(async (req, res) => {
  const tasks = await prisma.task.findMany({
    where: {
      order: { cancelled: false },
      ...(req.query.orderId ? { orderId: req.query.orderId as string } : {}),
      ...(req.query.department ? { department: req.query.department as never } : {}),
      ...(req.query.status ? { status: req.query.status as never } : { status: { not: 'COMPLETED' } }),
      ...(req.query.assigneeId ? { assigneeId: req.query.assigneeId as string } : {}),
      ...(req.query.overdue === 'true' ? { dueDate: { lt: new Date() }, status: { not: 'COMPLETED' } } : {}),
    },
    include: TASK_INCLUDE,
    orderBy: [{ dueDate: 'asc' }],
    take: Math.min(300, Number(req.query.limit) || 100),
  });
  res.json({ data: tasks.map((t) => toDto(t)) });
}));

tasksRouter.get('/:id', requirePermission('task:read'), asyncHandler(async (req, res) => {
  const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: TASK_INCLUDE });
  if (!task) throw new NotFoundError('Task');
  res.json(toDto(task));
}));

tasksRouter.post('/:id/start', requirePermission('task:complete'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  await startTask(prisma, req.params.id, actor.id, actor.name);
  const task = await prisma.task.findUniqueOrThrow({ where: { id: req.params.id }, include: TASK_INCLUDE });
  await refreshOrderCache(task.order.id);
  res.json(toDto(task));
}));

const completeSchema = z.object({
  notes: z.string().optional(),
  actualMinutes: z.number().int().positive().optional(),
});

tasksRouter.post('/:id/complete', requirePermission('task:complete'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const input = completeSchema.parse(req.body ?? {});

  const existing = await prisma.task.findUnique({
    where: { id: req.params.id },
    select: { assigneeId: true, department: true },
  });
  if (!existing) throw new NotFoundError('Task');

  // A task may be completed by its assignee, by someone in the responsible
  // department, or by anyone who can assign tasks (coordinator, admin).
  const mayComplete =
    existing.assigneeId === actor.id ||
    existing.department === actor.department ||
    actor.permissions.includes('task:assign');
  if (!mayComplete) {
    throw new ForbiddenError(
      `This task belongs to ${DEPARTMENT_LABEL[existing.department].en}. Ask them to complete it, or reassign it first.`,
    );
  }

  await completeTask(prisma, { taskId: req.params.id, actorId: actor.id, actorName: actor.name, ...input });

  const task = await prisma.task.findUniqueOrThrow({ where: { id: req.params.id }, include: TASK_INCLUDE });
  await refreshOrderCache(task.order.id);
  res.json(toDto(task));
}));

tasksRouter.post('/:id/reopen', requirePermission('task:assign'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) throw new NotFoundError('Task');

  await prisma.task.update({
    where: { id: task.id },
    data: { status: 'IN_PROGRESS', completedAt: null, completedById: null },
  });
  await logActivity({
    orderId: task.orderId, actorId: actor.id, actorName: actor.name,
    action: 'TASK_REOPENED', summary: `reopened "${task.title}"`,
    entityType: 'Task', entityId: task.id,
  });

  await refreshOrderCache(task.orderId);
  const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: TASK_INCLUDE });
  res.json(toDto(updated));
}));

const assignSchema = z.object({ assigneeId: z.string().nullable() });

tasksRouter.post('/:id/assign', requirePermission('task:assign'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const { assigneeId } = assignSchema.parse(req.body);
  await assignTask(prisma, req.params.id, assigneeId, actor.id, actor.name);
  const task = await prisma.task.findUniqueOrThrow({ where: { id: req.params.id }, include: TASK_INCLUDE });
  res.json(toDto(task));
}));

const patchSchema = z.object({
  dueDate: z.string().nullable().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  notes: z.string().nullable().optional(),
  status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'WAITING', 'BLOCKED']).optional(),
  blockedReason: z.string().nullable().optional(),
});

tasksRouter.patch('/:id', requirePermission('task:assign'), asyncHandler(async (req, res) => {
  const input = patchSchema.parse(req.body);
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) throw new NotFoundError('Task');

  await prisma.task.update({
    where: { id: task.id },
    data: {
      ...input,
      dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null,
    },
  });

  await refreshOrderCache(task.orderId);
  const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: TASK_INCLUDE });
  res.json(toDto(updated));
}));

// ── Comments ────────────────────────────────────────────────────────────────

tasksRouter.get('/:id/comments', requirePermission('task:read'), asyncHandler(async (req, res) => {
  const comments = await prisma.taskComment.findMany({
    where: { taskId: req.params.id },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    data: comments.map((c) => ({
      id: c.id, body: c.body, authorId: c.author.id, authorName: c.author.name,
      createdAt: c.createdAt.toISOString(),
    })),
  });
}));

tasksRouter.post('/:id/comments', requirePermission('task:read'), asyncHandler(async (req, res) => {
  const actor = currentUser(req);
  const body = z.object({ body: z.string().min(1) }).parse(req.body).body;

  const task = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!task) throw new NotFoundError('Task');

  const comment = await prisma.taskComment.create({
    data: { taskId: task.id, authorId: actor.id, body },
    include: { author: { select: { id: true, name: true } } },
  });

  await logActivity({
    orderId: task.orderId, actorId: actor.id, actorName: actor.name,
    action: 'TASK_COMMENTED', summary: `commented on "${task.title}"`,
    entityType: 'Task', entityId: task.id,
  });

  res.status(201).json({
    id: comment.id, body: comment.body, authorId: comment.author.id,
    authorName: comment.author.name, createdAt: comment.createdAt.toISOString(),
  });
}));
