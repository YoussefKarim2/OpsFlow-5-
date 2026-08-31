/**
 * The guided step rail — the answer to "where do I go next?".
 *
 * The order workspace used to open on sixteen equal tabs. Sixteen equal doors
 * is not a workflow; it is a filing cabinet, and it asks the coordinator to
 * already know the process. The rail replaces that with the factory's own
 * eighteen steps, in the factory's own order, with exactly one of them lit up.
 *
 * Three rules it follows:
 *
 * **One current step.** Highlighted, numbered, at the top of the page as well
 * as in the rail. Never two, never none.
 *
 * **Say what is missing.** Every outstanding step carries a sentence naming
 * what it still wants. "In progress" without that sentence is a shrug.
 *
 * **"Not required" is an answer.** A step this order does not need is shown
 * greyed and dashed with the reason, and left out of the progress count — never
 * ticked, never silently hidden.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check, ChevronRight, CircleDashed, Clock, Minus, AlertTriangle, Loader2, RotateCcw,
} from 'lucide-react';
import {
  StageStatus, StepState, DEPARTMENT_LABEL,
  type StageKey, type OrderStepState,
} from '@opsflow/shared';
import { api, type OrderStepsPayload } from '../../lib/api';
import { Card, Modal, Field, clsx, useToast } from '../../components/ui';

// ─────────────────────────────────────────────────────────────────────────────
// Look
// ─────────────────────────────────────────────────────────────────────────────

const STATE_LOOK: Record<StepState, {
  label: string;
  dot: string;
  row: string;
  Icon: typeof Check;
}> = {
  COMPLETED: {
    label: 'Done', Icon: Check,
    dot: 'bg-emerald-500 text-white',
    row: 'text-ink-500',
  },
  IN_PROGRESS: {
    label: 'In progress', Icon: Loader2,
    dot: 'bg-accent-500 text-white',
    row: 'text-ink-900',
  },
  WAITING: {
    label: 'Waiting', Icon: Clock,
    dot: 'bg-amber-400 text-white',
    row: 'text-ink-900',
  },
  BLOCKED: {
    label: 'Blocked', Icon: AlertTriangle,
    dot: 'bg-red-500 text-white',
    row: 'text-red-800',
  },
  NOT_REQUIRED: {
    label: 'Not required', Icon: Minus,
    dot: 'border border-dashed border-ink-300 bg-ink-50 text-ink-400',
    row: 'text-ink-400',
  },
  NOT_STARTED: {
    label: 'Not started', Icon: CircleDashed,
    dot: 'border border-ink-300 bg-white text-ink-400',
    row: 'text-ink-600',
  },
};

function StepDot({ state, number }: { state: StepState; number: number }) {
  const look = STATE_LOOK[state];
  return (
    <span
      title={look.label}
      className={clsx(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold leading-none',
        look.dot,
      )}
    >
      {state === 'COMPLETED' ? <Check className="h-3.5 w-3.5" />
        : state === 'NOT_REQUIRED' ? <Minus className="h-3 w-3" />
        : state === 'BLOCKED' ? <AlertTriangle className="h-3 w-3" />
        : number}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The rail
// ─────────────────────────────────────────────────────────────────────────────

export function StepRail({
  steps, activeKey, onJump,
}: {
  steps: OrderStepsPayload;
  activeKey: StageKey | null;
  onJump: (step: OrderStepState) => void;
}) {
  return (
    <nav aria-label="Order steps" className="flex h-full w-64 shrink-0 flex-col border-r border-ink-200 bg-white">
      <div className="border-b border-ink-200 px-3 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
            The order routine
          </span>
          <span className="tnum text-sm font-semibold text-ink-900">{steps.percentComplete}%</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
          <div
            className="h-full rounded-full bg-accent-500 transition-all"
            style={{ width: `${steps.percentComplete}%` }}
          />
        </div>
        <p className="mt-1 text-2xs text-ink-500">
          {steps.completedCount} of {steps.applicableCount} steps this order needs
          {steps.applicableCount < steps.steps.length && (
            <> · {steps.steps.length - steps.applicableCount} not required</>
          )}
        </p>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto py-1">
        {steps.steps.map((s) => {
          const look = STATE_LOOK[s.state];
          const isActive = s.key === activeKey;
          return (
            <li key={s.key}>
              <button
                onClick={() => onJump(s)}
                aria-current={s.isCurrent ? 'step' : undefined}
                className={clsx(
                  'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors',
                  isActive ? 'bg-accent-50' : 'hover:bg-ink-50',
                  s.isCurrent && !isActive && 'bg-accent-50/50',
                )}
              >
                <StepDot state={s.state} number={s.order} />
                <span className="min-w-0 flex-1">
                  <span className={clsx('block truncate text-sm font-medium', look.row)}>
                    {s.label}
                  </span>
                  {s.isCurrent ? (
                    <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-accent-600 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">
                      You are here
                    </span>
                  ) : s.state === 'NOT_REQUIRED' && s.notRequiredReason ? (
                    <span className="mt-0.5 block truncate text-2xs italic text-ink-400">
                      {s.notRequiredReason}
                    </span>
                  ) : s.missing && s.state !== 'COMPLETED' ? (
                    <span className="mt-0.5 block truncate text-2xs text-ink-500">{s.missing}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel above whatever screen the step opens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a beginner needs to act on this step without asking anyone:
 * what it is for, who normally does it, what they type, what is still missing,
 * and the one button that moves the order on.
 */
export function StepHeader({
  orderId, steps, step,
}: {
  orderId: string;
  steps: OrderStepsPayload;
  step: OrderStepState;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'not-required' | 'waiting'>(null);
  const [reason, setReason] = useState('');

  const mutate = useMutation({
    mutationFn: (body: { status: StageStatus | null; reason?: string }) =>
      api.steps.setStatus(orderId, step.key, body),
    onSuccess: (res, vars) => {
      qc.setQueryData(['order-steps', orderId], res);
      // A step change can move stock, unblock a gate, or finish the order.
      qc.invalidateQueries({ queryKey: ['order', orderId] });
      setDialog(null);
      setReason('');
      toast.success(
        vars.status === null ? `"${step.label}" is back to being worked out from the order`
        : vars.status === 'COMPLETED' ? `"${step.label}" marked done`
        : vars.status === 'NOT_REQUIRED' ? `"${step.label}" marked not required`
        : `"${step.label}" put on hold`,
      );
    },
    onError: (e) => toast.error(e),
  });

  const look = STATE_LOOK[step.state];
  const blocker = steps.blockers.find((b) => b.stageKey === step.key);
  const busy = mutate.isPending;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StepDot state={step.state} number={step.order} />
              <h2 className="text-base font-semibold text-ink-900">
                Step {step.order} of {steps.steps.length} — {step.label}
              </h2>
              <span className={clsx(
                'chip',
                step.state === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                : step.state === 'BLOCKED' ? 'bg-red-50 text-red-700 ring-red-600/20'
                : step.state === 'WAITING' ? 'bg-amber-50 text-amber-800 ring-amber-600/20'
                : step.state === 'NOT_REQUIRED' ? 'bg-ink-100 text-ink-500 ring-ink-400/20'
                : step.state === 'IN_PROGRESS' ? 'bg-accent-50 text-accent-700 ring-accent-600/20'
                : 'bg-ink-50 text-ink-500 ring-ink-300/40',
              )}>
                {look.label}
              </span>
            </div>

            <p className="mt-1.5 text-sm text-ink-700">{step.purpose}</p>

            <p className="mt-1 text-xs text-ink-500">
              Usually done by <span className="font-medium text-ink-700">
                {DEPARTMENT_LABEL[step.department]?.en ?? step.department}
              </span>
              {' · '}
              from the workbook sheet <span className="font-mono">{step.sheetName}</span>
            </p>

            {step.state === 'NOT_REQUIRED' ? (
              <p className="mt-2.5 rounded border border-dashed border-ink-300 bg-ink-50 px-3 py-2 text-xs text-ink-600">
                <span className="font-semibold">Not required for this order.</span>{' '}
                {step.notRequiredReason ?? 'No reason was recorded.'}
              </p>
            ) : (
              <>
                <div className="mt-2.5">
                  <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                    What you enter here
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {step.whatYouEnter.map((w) => (
                      <li key={w} className="flex items-start gap-1.5 text-xs text-ink-700">
                        <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>

                {blocker && (
                  <div className="mt-2.5 rounded border border-red-200 bg-red-50 px-3 py-2">
                    <p className="text-xs font-semibold text-red-800">
                      Blocked: {blocker.requirement}
                    </p>
                    <p className="mt-0.5 text-xs text-red-700">{blocker.detail}</p>
                  </div>
                )}

                {step.missing && !blocker && step.state !== 'COMPLETED' && (
                  <p className="mt-2.5 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <span className="font-semibold">Still needed:</span> {step.missing}
                  </p>
                )}

                {step.taskTotal > 0 && (
                  <p className="mt-2 text-xs text-ink-500">
                    {step.taskCompleted} of {step.taskTotal} workflow tasks complete on this step.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="flex w-full shrink-0 flex-col gap-1.5 sm:w-52">
            {step.state === 'COMPLETED' ? (
              <button
                className="btn-ghost btn-sm justify-center"
                disabled={busy}
                onClick={() => mutate.mutate({ status: null })}
              >
                <RotateCcw className="h-3.5 w-3.5" /> Reopen this step
              </button>
            ) : step.state === 'NOT_REQUIRED' ? (
              <button
                className="btn-ghost btn-sm justify-center"
                disabled={busy}
                onClick={() => mutate.mutate({ status: null })}
              >
                <RotateCcw className="h-3.5 w-3.5" /> This order does need it
              </button>
            ) : (
              <>
                <button
                  className="btn-primary btn-sm justify-center"
                  disabled={busy}
                  onClick={() => mutate.mutate({ status: StageStatus.COMPLETED })}
                >
                  <Check className="h-3.5 w-3.5" /> Mark this step done
                </button>
                <button
                  className="btn-ghost btn-sm justify-center"
                  disabled={busy}
                  onClick={() => setDialog('waiting')}
                >
                  <Clock className="h-3.5 w-3.5" /> Waiting on someone
                </button>
                <button
                  className="btn-ghost btn-sm justify-center"
                  disabled={busy}
                  onClick={() => setDialog('not-required')}
                >
                  <Minus className="h-3.5 w-3.5" /> Not required
                </button>
              </>
            )}

            {steps.next && step.isCurrent && (
              <p className="mt-1 text-2xs text-ink-500">
                Next after this: <span className="font-medium text-ink-700">{steps.next.label}</span>
              </p>
            )}
          </div>
        </div>

        {step.state !== 'COMPLETED' && step.state !== 'NOT_REQUIRED' && (
          <p className="border-t border-ink-100 bg-ink-50 px-4 py-2 text-2xs text-ink-500">
            Marking a step done records <em>your</em> decision. It does not claim anything was
            produced, issued or approved — those are recorded on the screen below.
          </p>
        )}
      </Card>

      <Modal
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === 'not-required' ? `Why does this order not need "${step.label}"?` : `What is "${step.label}" waiting on?`}
        subtitle={
          dialog === 'not-required'
            ? 'The reason is shown wherever the step is, so nobody has to ask you in six weeks.'
            : 'Waiting means somebody outside the system owes you something.'
        }
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setDialog(null)}>Cancel</button>
            <button
              className="btn-primary btn-sm"
              disabled={busy || (dialog === 'not-required' && reason.trim().length === 0)}
              onClick={() => mutate.mutate({
                status: dialog === 'not-required' ? StageStatus.NOT_REQUIRED : StageStatus.WAITING,
                reason: reason.trim() || undefined,
              })}
            >
              {dialog === 'not-required' ? 'Mark not required' : 'Put on hold'}
            </button>
          </>
        }
      >
        <Field
          label="Reason"
          hint={
            dialog === 'not-required'
              ? 'Required. For example: "Plain garment — no printing or embroidery on this order."'
              : 'Optional, but the next person to open this order will thank you.'
          }
        >
          <textarea
            className="input min-h-[5rem]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              dialog === 'not-required'
                ? 'Plain garment — no printing or embroidery on this order'
                : 'Waiting for the customer to confirm the shade'
            }
            autoFocus
          />
        </Field>
      </Modal>
    </>
  );
}
