/**
 * The workflow tab — the 27 tasks from `Progress Status`, grouped by the
 * sequence the factory actually works in.
 *
 * Completing a task can be refused by the server when the information the
 * process requires is missing. That refusal is shown verbatim, because the
 * message ("Issue the outstanding materials, or record a purchase order, before
 * completing this task") is the useful part.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Play, RotateCcw, Lock, Clock, MessageSquare } from 'lucide-react';
import {
  fmtDate, templateBySequence, DEPARTMENT_LABEL,
  type OrderDetailDto, type TaskDto,
} from '@opsflow/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  Card, CardHeader, Modal, Field, Avatar, PriorityBadge, FreeText, Spinner, clsx,
} from '../../components/ui';

export function TasksTab({ order }: { order: OrderDetailDto }) {
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const [refusal, setRefusal] = useState<{ title: string; message: string } | null>(null);
  const [detail, setDetail] = useState<TaskDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['order-tasks', order.id],
    queryFn: () => api.orders.tasks(order.id),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['order-tasks', order.id] });
    void qc.invalidateQueries({ queryKey: ['order', order.id] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const complete = useMutation({
    mutationFn: (taskId: string) => api.tasks.complete(taskId),
    onSuccess: invalidate,
    onError: (e, taskId) => {
      const task = data?.data.find((t) => t.id === taskId);
      setRefusal({
        title: task ? `Cannot complete “${task.title}”` : 'Cannot complete this task',
        message: e instanceof ApiError ? e.message : 'Something went wrong.',
      });
    },
  });

  const start = useMutation({ mutationFn: (id: string) => api.tasks.start(id), onSuccess: invalidate });
  const reopen = useMutation({ mutationFn: (id: string) => api.tasks.reopen(id), onSuccess: invalidate });

  if (isLoading) return <Spinner />;
  const tasks = data?.data ?? [];

  const sequences = [...new Set(tasks.map((t) => t.sequence))].sort((a, b) => a - b);
  const totalEstimate = tasks.reduce((a, t) => a + (t.estimatedMinutes ?? 0), 0);
  const done = tasks.filter((t) => t.status === 'COMPLETED').length;

  return (
    <div className="space-y-4 p-5">
      <Card>
        <CardHeader
          title="Workflow"
          subtitle={
            `${done} of ${tasks.length} tasks complete · ${totalEstimate} minutes of planned effort · ` +
            `sequenced exactly as the Progress Status sheet defines`
          }
        />
        <div className="p-4">
          {sequences.map((seq) => {
            const group = tasks.filter((t) => t.sequence === seq);
            const groupDone = group.every((t) => t.status === 'COMPLETED');
            const groupStarted = group.some((t) => t.status !== 'NOT_STARTED');

            return (
              <div key={seq} className="mb-5 last:mb-0">
                <div className="mb-2 flex items-center gap-2">
                  <span className={clsx(
                    'flex h-6 w-6 items-center justify-center rounded-full text-2xs font-bold',
                    groupDone ? 'bg-emerald-500 text-white'
                    : groupStarted ? 'bg-accent-600 text-white'
                    : 'border border-ink-300 bg-white text-ink-400',
                  )}>
                    {seq}
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">
                    Sequence {seq}
                  </span>
                  <span className="text-2xs text-ink-400">
                    {group.filter((t) => t.status === 'COMPLETED').length}/{group.length} ·{' '}
                    {group.reduce((a, t) => a + (t.estimatedMinutes ?? 0), 0)} min
                  </span>
                  <div className="h-px flex-1 bg-ink-200" />
                </div>

                <ul className="ml-3 space-y-1.5 border-l border-ink-200 pl-4">
                  {group.map((t) => {
                    const mine = t.assignee?.id === user?.id || t.department === user?.department;
                    const canAct = can('task:complete') && (mine || can('task:assign'));

                    return (
                      <li
                        key={t.id}
                        className={clsx(
                          'group relative rounded-md border px-3 py-2 transition-colors',
                          t.status === 'COMPLETED' ? 'border-emerald-200 bg-emerald-50/50'
                          : t.status === 'BLOCKED' ? 'border-red-200 bg-red-50/50'
                          : t.isOverdue ? 'border-orange-200 bg-orange-50/50'
                          : t.status === 'IN_PROGRESS' ? 'border-accent-200 bg-accent-50/40'
                          : 'border-ink-200 bg-white',
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <button
                            onClick={() => {
                              if (!canAct) return;
                              if (t.status === 'COMPLETED') reopen.mutate(t.id);
                              else complete.mutate(t.id);
                            }}
                            disabled={!canAct || complete.isPending}
                            className={clsx(
                              'mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border transition-colors',
                              t.status === 'COMPLETED'
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : t.status === 'BLOCKED'
                                  ? 'border-red-300 bg-white text-red-400'
                                  : 'border-ink-300 bg-white hover:border-accent-500',
                              !canAct && 'cursor-not-allowed opacity-60',
                            )}
                            title={
                              !canAct ? `Only ${DEPARTMENT_LABEL[t.department].en} can complete this`
                              : t.status === 'COMPLETED' ? 'Reopen' : 'Mark complete'
                            }
                          >
                            {t.status === 'COMPLETED' && <Check className="h-3 w-3" />}
                            {t.status === 'BLOCKED' && <Lock className="h-2.5 w-2.5" />}
                          </button>

                          <button onClick={() => setDetail(t)} className="min-w-0 flex-1 text-left">
                            <p className={clsx(
                              'text-sm',
                              t.status === 'COMPLETED' ? 'text-ink-500 line-through' : 'font-medium text-ink-900',
                            )}>
                              {t.title}
                            </p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-ink-500">
                              <span className="font-medium">{t.departmentLabel}</span>
                              {t.assignee && (
                                <span className="flex items-center gap-1">
                                  <Avatar name={t.assignee.name} size="sm" />{t.assignee.name}
                                </span>
                              )}
                              {t.estimatedMinutes && (
                                <span className="flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />{t.estimatedMinutes}m</span>
                              )}
                              {t.dueDate && (
                                <span className={clsx(t.isOverdue && 'font-semibold text-red-600')}>
                                  due {fmtDate(t.dueDate)}
                                  {t.isOverdue && ` · ${Math.abs(t.daysRemaining ?? 0)}d late`}
                                </span>
                              )}
                              {t.commentCount > 0 && (
                                <span className="flex items-center gap-0.5"><MessageSquare className="h-2.5 w-2.5" />{t.commentCount}</span>
                              )}
                            </div>
                            {t.blockedReason && (
                              <p className="mt-1 rounded bg-red-100 px-2 py-1 text-2xs text-red-800">
                                <FreeText text={t.blockedReason} />
                              </p>
                            )}
                          </button>

                          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            {t.status === 'NOT_STARTED' && canAct && (
                              <button onClick={() => start.mutate(t.id)} className="btn-ghost btn-sm" title="Start">
                                <Play className="h-3 w-3" />
                              </button>
                            )}
                            {t.status === 'COMPLETED' && can('task:assign') && (
                              <button onClick={() => reopen.mutate(t.id)} className="btn-ghost btn-sm" title="Reopen">
                                <RotateCcw className="h-3 w-3" />
                              </button>
                            )}
                            {t.priority !== 'MEDIUM' && <PriorityBadge priority={t.priority} />}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </Card>

      {/* A rule refusal is an explanation, not an error toast. */}
      <Modal
        open={!!refusal} onClose={() => setRefusal(null)}
        title={refusal?.title ?? ''}
        footer={<button onClick={() => setRefusal(null)} className="btn-primary">Understood</button>}
      >
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="text-sm leading-relaxed text-amber-900">{refusal?.message}</p>
        </div>
        <p className="mt-3 text-xs text-ink-500">
          The process defined in the Progress Status sheet requires this information before the
          step can be signed off. In the spreadsheet this was a written instruction; here it is
          enforced, so an order cannot advance on incomplete data.
        </p>
      </Modal>

      <TaskDetailModal task={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function TaskDetailModal({ task, onClose }: { task: TaskDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');

  const { data: comments } = useQuery({
    queryKey: ['task-comments', task?.id],
    queryFn: () => api.tasks.comments(task!.id),
    enabled: !!task,
  });

  const post = useMutation({
    mutationFn: () => api.tasks.comment(task!.id, comment),
    onSuccess: () => {
      setComment('');
      void qc.invalidateQueries({ queryKey: ['task-comments', task?.id] });
    },
  });

  if (!task) return null;

  return (
    <Modal open onClose={onClose} title={task.title} subtitle={`${task.departmentLabel} · sequence ${task.sequence}`} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Requirement (English)">
            <p className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-800">
              {task.requirementEn || '—'}
            </p>
          </Field>
          <Field label="Requirement (original)">
            <div className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-800">
              <FreeText text={task.requirementAr} />
            </div>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Meta label="Status" value={task.status.replace(/_/g, ' ')} />
          <Meta label="Assignee" value={task.assignee?.name ?? 'Unassigned'} />
          <Meta label="Due" value={fmtDate(task.dueDate)} />
          <Meta label="Estimated" value={task.estimatedMinutes ? `${task.estimatedMinutes} min` : '—'} />
          {task.completedAt && <Meta label="Completed" value={fmtDate(task.completedAt)} />}
          {task.completedBy && <Meta label="Completed by" value={task.completedBy.name} />}
        </div>

        <div>
          <p className="label">Comments</p>
          <ul className="mb-2 max-h-48 space-y-2 overflow-y-auto">
            {(comments?.data ?? []).length === 0 && (
              <li className="text-xs text-ink-400">No comments yet.</li>
            )}
            {(comments?.data ?? []).map((c) => (
              <li key={c.id} className="flex gap-2">
                <Avatar name={c.authorName} size="sm" />
                <div className="min-w-0 flex-1 rounded border border-ink-200 bg-white px-2.5 py-1.5">
                  <p className="text-2xs font-medium text-ink-600">{c.authorName} · {fmtDate(c.createdAt)}</p>
                  <p className="mt-0.5 text-sm text-ink-800"><FreeText text={c.body} /></p>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input
              value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment…" className="input"
              onKeyDown={(e) => { if (e.key === 'Enter' && comment.trim()) post.mutate(); }}
            />
            <button
              onClick={() => post.mutate()} disabled={!comment.trim() || post.isPending}
              className="btn-primary btn-sm shrink-0"
            >
              Post
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xs font-medium uppercase tracking-wider text-ink-500">{label}</p>
      <p className="mt-0.5 text-sm text-ink-800">{value}</p>
    </div>
  );
}

export { templateBySequence };
