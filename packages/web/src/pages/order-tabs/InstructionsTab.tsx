/**
 * Step 10 — Custom Instructions.
 *
 * The workbook's Custom Instructions sheet is where the things that are true of
 * *this* order and no other get written down: a stitch the customer insists on,
 * a fold, a note that the neck tape runs the other way. In the workbook they
 * were free text nobody was routed to. Here each instruction names the
 * departments that must see it.
 *
 * This step never completes itself. "No special instructions" is a decision
 * somebody makes, not an absence of typing — so the step waits for a person
 * either to write one or to say the order does not need any.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { DEPARTMENT_LABEL, fmtDate, type Department } from '@opsflow/shared';
import { api, type InstructionDto } from '../../lib/api';
import { Card, Modal, Field, Spinner, EmptyState, ConfirmDialog, clsx, useToast } from '../../components/ui';

const DEPARTMENTS: Department[] = [
  'COORDINATOR', 'FACTORY_MANAGER', 'PRODUCTION_MANAGER', 'CUTTING_MARKER',
  'WAREHOUSE', 'EXTERNAL_OPS', 'PACKING', 'QUALITY', 'FOLLOW_UP', 'FINANCE',
];

interface Draft {
  id: string | null;
  title: string;
  body: string;
  visibleTo: string[];
}

const EMPTY: Draft = { id: null, title: '', body: '', visibleTo: [] };

export function InstructionsTab({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<InstructionDto | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['instructions', orderId],
    queryFn: () => api.steps.instructions(orderId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['instructions', orderId] });
    qc.invalidateQueries({ queryKey: ['order-steps', orderId] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id
        ? api.steps.updateInstruction(orderId, d.id, { title: d.title, body: d.body, visibleTo: d.visibleTo })
        : api.steps.addInstruction(orderId, { title: d.title, body: d.body, visibleTo: d.visibleTo }),
    onSuccess: () => { refresh(); setDraft(null); toast.success('Instruction saved'); },
    onError: (e) => toast.error(e),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.steps.removeInstruction(orderId, id),
    onSuccess: () => { refresh(); setConfirmDelete(null); toast.success('Instruction removed'); },
    onError: (e) => toast.error(e),
  });

  const rows = data?.data ?? [];
  const valid = draft != null
    && draft.title.trim().length > 0
    && draft.body.trim().length > 0
    && draft.visibleTo.length > 0;

  if (isLoading) return <Spinner label="Loading instructions…" />;

  return (
    <div className="space-y-4 p-5">
      <Card>
        <div className="card-header">
          <h3 className="card-title">Instructions for this order only</h3>
          <button className="btn-primary btn-sm" onClick={() => setDraft(EMPTY)}>
            <Plus className="h-3.5 w-3.5" /> Add an instruction
          </button>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title="No special instructions yet"
            detail={
              'If this order is made exactly like any other, that is an answer too — mark the step ' +
              '“Not required” above and say so. Leaving it blank tells the next person nothing.'
            }
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-semibold text-ink-900">{r.title}</h4>
                    <div
                      className="prose-instruction mt-1 text-sm text-ink-700"
                      // Sanitised server-side on write: script, style, iframe and
                      // every attribute are stripped before it is ever stored.
                      dangerouslySetInnerHTML={{ __html: r.body }}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-2xs text-ink-500">Must be read by:</span>
                      {r.visibleTo.map((d) => (
                        <span key={d} className="chip bg-ink-100 text-ink-700 ring-ink-300/40">
                          {DEPARTMENT_LABEL[d as Department]?.en ?? d}
                        </span>
                      ))}
                      <span className="text-2xs text-ink-400">· updated {fmtDate(r.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => setDraft({ id: r.id, title: r.title, body: r.body, visibleTo: r.visibleTo })}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      className="btn-ghost btn-sm text-red-600 hover:bg-red-50"
                      onClick={() => setConfirmDelete(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit instruction' : 'New instruction'}
        subtitle="Whoever you tick sees this on their own screens for this order."
        wide
        footer={
          <>
            <button className="btn-ghost btn-sm" onClick={() => setDraft(null)}>Cancel</button>
            <button
              className="btn-primary btn-sm"
              disabled={!valid || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              Save instruction
            </button>
          </>
        }
      >
        {draft && (
          <div className="space-y-3">
            <Field label="Title" hint="Short enough to scan in a list. “Neck tape runs the other way.”">
              <input
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                maxLength={200}
                autoFocus
              />
            </Field>

            <Field
              label="The instruction"
              hint="Plain text or simple formatting. Anything that could run as code is removed when it is saved."
            >
              <textarea
                className="input min-h-[8rem]"
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </Field>

            <Field label="Who must read it?" hint="At least one. An instruction nobody is routed to is a note in a drawer.">
              <div className="flex flex-wrap gap-1.5">
                {DEPARTMENTS.map((d) => {
                  const on = draft.visibleTo.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDraft({
                        ...draft,
                        visibleTo: on
                          ? draft.visibleTo.filter((x) => x !== d)
                          : [...draft.visibleTo, d],
                      })}
                      className={clsx(
                        'rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors',
                        on
                          ? 'bg-accent-600 text-white ring-accent-600'
                          : 'bg-white text-ink-600 ring-ink-300 hover:bg-ink-50',
                      )}
                    >
                      {DEPARTMENT_LABEL[d]?.en ?? d}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete.id)}
        busy={remove.isPending}
        title="Remove this instruction?"
        confirmLabel="Remove"
        body={<>“{confirmDelete?.title}” will no longer be shown to anyone working this order.</>}
      />
    </div>
  );
}
