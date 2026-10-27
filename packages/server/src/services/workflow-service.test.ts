/**
 * Tasks following their order, and a task being completed once.
 *
 * The database is a small fake: these rules are about which rows are asked
 * for and written, and that is what the fake records.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { planDueDate } from '@opsflow/shared';

import {
  reassignOpenTasks, replanTaskDueDates, mayWorkTask, completeTask, startTask, NAMED_OWNER_DEPARTMENT,
} from './workflow-service.js';
import { ConflictError } from '../errors.js';

type Where = Record<string, unknown>;

describe('a new coordinator takes over the open coordinator tasks', () => {
  const recorder = () => {
    const calls: Array<{ where: Where; data: Where }> = [];
    const db = {
      task: { updateMany: async (args: { where: Where; data: Where }) => { calls.push(args); return { count: 3 }; } },
    };
    return { calls, db: db as never };
  };

  test('only open tasks of that department still with the old person move', async () => {
    const { calls, db } = recorder();
    const moved = await reassignOpenTasks(db, { orderId: 'o1', department: 'COORDINATOR', fromId: 'old', toId: 'new' });
    assert.equal(moved, 3);
    assert.deepEqual(calls[0]!.where, {
      orderId: 'o1', department: 'COORDINATOR', status: { not: 'COMPLETED' }, assigneeId: 'old',
    });
    assert.deepEqual(calls[0]!.data, { assigneeId: 'new' });
  });

  test('clearing the name, or naming the same person, moves nothing', async () => {
    const { calls, db } = recorder();
    assert.equal(await reassignOpenTasks(db, { orderId: 'o1', department: 'COORDINATOR', fromId: 'old', toId: null }), 0);
    assert.equal(await reassignOpenTasks(db, { orderId: 'o1', department: 'COORDINATOR', fromId: 'same', toId: 'same' }), 0);
    assert.equal(calls.length, 0);
  });

  test('the two named people own the coordinator and outside-work tasks', () => {
    assert.equal(NAMED_OWNER_DEPARTMENT.coordinatorId, 'COORDINATOR');
    assert.equal(NAMED_OWNER_DEPARTMENT.outsideWorkManagerId, 'EXTERNAL_OPS');
  });
});

describe('moved order dates re-plan the open tasks', () => {
  const poDate = new Date('2026-10-01T00:00:00Z');
  const ship = new Date('2026-12-01T00:00:00Z');

  test('asks only for open, planned, never-hand-edited tasks, and moves those that changed', async () => {
    let findWhere: Where | null = null;
    const writes: Array<{ where: Where; data: Where }> = [];
    const db = {
      task: {
        findMany: async (args: { where: Where }) => {
          findWhere = args.where;
          return [
            { id: 'a', sequence: 2, dueDate: new Date('2026-10-03T00:00:00Z') },
            { id: 'b', sequence: 2, dueDate: null },
            // Already on the new plan: left alone.
            { id: 'c', sequence: 5, dueDate: planDueDate(5, poDate, ship) },
          ];
        },
        updateMany: async (args: { where: Where; data: Where }) => {
          writes.push(args);
          return { count: (args.where.id as { in: string[] }).in.length };
        },
      },
    };

    const moved = await replanTaskDueDates(db as never, { orderId: 'o1', poDate, promisedShippingDate: ship });

    assert.deepEqual(findWhere, {
      orderId: 'o1',
      status: { not: 'COMPLETED' },
      isCorrectiveAction: false,
      OR: [{ dueDateManual: null }, { dueDateManual: false }],
    });
    assert.equal(moved, 2);
    assert.equal(writes.length, 1, 'one write for the sequence group');
    assert.deepEqual(writes[0]!.where, { id: { in: ['a', 'b'] } });
    assert.deepEqual(writes[0]!.data, { dueDate: planDueDate(2, poDate, ship) });
  });
});

describe('who may work a task', () => {
  const task = { assigneeId: 'u1', department: 'CUTTING' };

  test('its assignee, its department, or someone who assigns tasks', () => {
    assert.ok(mayWorkTask(task, { id: 'u1', department: 'PACKING', permissions: [] }));
    assert.ok(mayWorkTask(task, { id: 'u2', department: 'CUTTING', permissions: [] }));
    assert.ok(mayWorkTask(task, { id: 'u3', department: 'PACKING', permissions: ['task:assign'] }));
  });

  test('not anyone else', () => {
    assert.equal(mayWorkTask(task, { id: 'u4', department: 'PACKING', permissions: ['task:complete'] }), false);
  });
});

describe('a task is completed once', () => {
  /** A task, and a transaction that may find it already completed by then. */
  const fake = (status: string, statusInsideTransaction = status) => {
    const seen = { updates: 0, activity: 0 };
    const task = {
      id: 't1', orderId: 'o1', status, title: 'Cut', notes: null, actualMinutes: null, startedAt: null,
      templateKey: null, blockedByTaskId: null, sourceAuditId: null, sequence: 1,
      stageKey: 'CUT_ORDER', department: 'CUTTING',
      order: { id: 'o1', poNumber: 'PO-1', coordinatorId: null },
    };
    const tx = {
      $queryRaw: async () => [],
      task: {
        findUnique: async () => ({ status: statusInsideTransaction }),
        update: async () => { seen.updates++; return { ...task, status: 'COMPLETED' }; },
        count: async () => 1,
        updateMany: async () => ({ count: 0 }),
        findMany: async () => [],
      },
      activityLog: { create: async () => { seen.activity++; } },
      notification: { createMany: async () => ({ count: 0 }) },
    };
    const db = {
      task: {
        findUnique: async () => task,
        update: async () => { seen.updates++; return task; },
      },
      activityLog: { create: async () => { seen.activity++; } },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    return { seen, db: db as unknown as PrismaClient };
  };

  test('an open task is completed and logged', async () => {
    const { seen, db } = fake('IN_PROGRESS');
    await completeTask(db, { taskId: 't1', actorId: 'u1', actorName: 'A' });
    assert.equal(seen.updates, 1);
    assert.equal(seen.activity, 1);
  });

  test('completing a completed task is refused, and nothing runs again', async () => {
    const { seen, db } = fake('COMPLETED');
    await assert.rejects(completeTask(db, { taskId: 't1', actorId: 'u1', actorName: 'A' }), ConflictError);
    assert.equal(seen.updates, 0);
    assert.equal(seen.activity, 0);
  });

  test('two at once: the second finds it completed under the lock and does nothing', async () => {
    const { seen, db } = fake('IN_PROGRESS', 'COMPLETED');
    await assert.rejects(completeTask(db, { taskId: 't1', actorId: 'u1', actorName: 'A' }), ConflictError);
    assert.equal(seen.updates, 0);
    assert.equal(seen.activity, 0);
  });

  test('a completed task cannot be started again', async () => {
    const { seen, db } = fake('COMPLETED');
    await assert.rejects(startTask(db, 't1', 'u1', 'A'), ConflictError);
    assert.equal(seen.updates, 0);
  });

  test('an open task can be started', async () => {
    const { seen, db } = fake('NOT_STARTED');
    await startTask(db, 't1', 'u1', 'A');
    assert.equal(seen.updates, 1);
  });
});
