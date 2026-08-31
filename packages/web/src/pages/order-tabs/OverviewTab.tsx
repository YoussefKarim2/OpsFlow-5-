/**
 * The Overview tab.
 *
 * This screen is the whole point of the project. The brief's section 42 says
 * the coordinator should never need to open fifteen pages to understand an
 * order, and lists twenty questions they must be able to answer immediately.
 * Every one of those twenty is answered on this page without a click.
 */

import {
  fmtDate, fmtNumber, LEDGER_LABEL, SEVERITY_STYLE, STAGE_META,
  type OrderDetailDto, type StageKey,
} from '@opsflow/shared';
import { AlertTriangle, ArrowRight, Package, Scissors, Boxes, ShieldCheck } from 'lucide-react';
import { Card, CardHeader, ProgressBar, StageDot, Num, FreeText, clsx } from '../../components/ui';

export function OverviewTab({
  order, onJump,
}: {
  order: OrderDetailDto;
  onJump: (tab: string) => void;
}) {
  const funnel = order.funnel;
  const qty = (l: string) => funnel.find((f) => f.ledger === l)?.qty ?? 0;

  return (
    <div className="space-y-4 p-5">
      {/* ── Blockers first ───────────────────────────────────────────────────
          §27: the coordinator should not scroll past twelve panels to find out
          why the order is stopped. If something is blocking it, that is the
          first thing on the page, in red, with somewhere to go. */}
      {order.blockers.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-red-300 bg-red-50">
          <div className="flex items-center gap-2 border-b border-red-200 px-4 py-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
            <h2 className="text-sm font-semibold text-red-900">
              {order.blockers.length} thing{order.blockers.length === 1 ? '' : 's'} blocking this order
            </h2>
          </div>
          <ul className="divide-y divide-red-200/70">
            {order.blockers.map((b) => (
              <li key={`${b.stageKey}-${b.key}`} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-red-900">
                    {b.stageLabel} — {b.requirement}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-red-800">{b.detail}</p>
                </div>
                {b.tab && (
                  <button onClick={() => onJump(b.tab!)} className="btn-secondary btn-sm shrink-0">
                    {b.actionLabel ?? 'Open'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {order.blockers.length === 0 && order.readyStages.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
          <p className="text-sm text-emerald-900">
            Nothing is blocking this order. Every requirement for the current stage is met.
          </p>
        </div>
      )}

      {/* Material status — one line, because the detail lives on its own tab. */}
      {order.materials && (
        <Card>
          <CardHeader
            title="Material status"
            subtitle={
              order.materials.shortCount > 0
                ? `${order.materials.shortCount} material${order.materials.shortCount === 1 ? '' : 's'} short of stock`
                : order.materials.reservableCount > 0
                  ? `${order.materials.reservableCount} line${order.materials.reservableCount === 1 ? '' : 's'} in stock but not reserved`
                  : 'Everything required is secured'
            }
            action={<button className="btn-ghost btn-sm" onClick={() => onJump('materials')}>Open materials</button>}
          />
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <MaterialStat label="Covered" value={order.materials.coveredCount} total={order.materials.totalRequirements} tone="emerald" />
            <MaterialStat label="Reservable" value={order.materials.reservableCount} total={order.materials.totalRequirements} tone="blue" />
            <MaterialStat label="Short" value={order.materials.shortCount} total={order.materials.totalRequirements} tone="red" />
            <MaterialStat label="Not linked" value={order.materials.unlinkedCount} total={order.materials.totalRequirements} tone="slate" />
          </div>
          {order.materials.topShortages.length > 0 && (
            <ul className="border-t border-ink-100 px-4 py-2.5 text-xs text-ink-700">
              {order.materials.topShortages.map((s) => (
                <li key={s.id} className="py-0.5">
                  <strong>{s.materialName}</strong> — short by{' '}
                  <strong className="tnum text-red-700">{fmtNumber(s.shortQty, { places: 0 })} {s.unit}</strong>
                  {' '}of {fmtNumber(s.outstandingQty, { places: 0 })} needed
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* ── Alerts and next action ───────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Alerts"
            subtitle={order.alerts.length === 0 ? 'Nothing needs attention.' : `${order.alerts.length} open`}
          />
          {order.alerts.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-emerald-700">
              No alerts. This order is progressing normally.
            </p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {order.alerts.map((a, i) => (
                <li key={`${a.code}-${i}`} className="px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 text-sm leading-none">{SEVERITY_STYLE[a.severity].icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink-900">{a.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-600">{a.detail}</p>
                      <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-accent-700">
                        <ArrowRight className="h-3 w-3" />{a.nextAction}
                      </p>
                    </div>
                    {a.tab && (
                      <button onClick={() => onJump(a.tab!)} className="btn-secondary btn-sm shrink-0">
                        Open
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Next action + dates */}
        <div className="space-y-4">
          <Card className="border-accent-200 bg-accent-50/40">
            <div className="p-4">
              <p className="text-2xs font-semibold uppercase tracking-wider text-accent-700">Next Action</p>
              <p className="mt-1.5 text-sm font-medium leading-snug text-ink-900">{order.nextAction.text}</p>
              {order.nextAction.department && (
                <p className="mt-1 text-xs text-ink-600">Owner: {order.nextAction.department}</p>
              )}
              <button onClick={() => onJump('tasks')} className="btn-primary btn-sm mt-3 w-full">
                Go to workflow
              </button>
            </div>
          </Card>

          <Card>
            <div className="divide-y divide-ink-100 text-sm">
              <DateRow label="PO date" value={order.poDate} />
              <DateRow label="Promised shipping" value={order.promisedShippingDate} />
              <DateRow
                label="Required delivery" value={order.requiredDeliveryDate}
                emphasis
                trailing={
                  order.production.daysUntilRequired == null ? null : (
                    <span className={clsx(
                      'tnum text-xs font-semibold',
                      order.production.daysUntilRequired < 0 ? 'text-red-600'
                      : order.production.daysUntilRequired <= 7 ? 'text-amber-600' : 'text-emerald-600',
                    )}>
                      {order.production.daysUntilRequired < 0
                        ? `${Math.abs(order.production.daysUntilRequired)} days late`
                        : `${order.production.daysUntilRequired} days left`}
                    </span>
                  )
                }
              />
            </div>
          </Card>
        </div>
      </div>

      {/* ── The quantity funnel: questions 10–15 ─────────────────────────── */}
      <Card>
        <CardHeader
          title="Where the pieces are"
          subtitle="Ordered → cut → produced → passed QC → packed → shipped"
          action={
            <button onClick={() => onJump('quantity')} className="btn-ghost btn-sm">
              Full matrix
            </button>
          }
        />
        <div className="grid grid-cols-2 divide-ink-100 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          {funnel.map((f) => (
            <div key={f.ledger} className="border-b border-ink-100 p-4 lg:border-b-0">
              <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                {LEDGER_LABEL[f.ledger]}
              </p>
              <p className="tnum mt-1 text-2xl font-semibold text-ink-900">{fmtNumber(f.qty)}</p>
              <div className="mt-2">
                <ProgressBar value={f.pctOfOrder} height="sm" />
                <p className="mt-1 text-2xs text-ink-500">
                  <Num value={f.pctOfOrder} kind="percent" /> of order
                </p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ── Grouped stage summary — the brief's mock-up, made real ───────── */}
      <div className="grid gap-4 lg:grid-cols-4">
        <StageGroup
          title="Order" icon={<Package className="h-4 w-4" />}
          stages={order.stages.filter((s) => s.group === 'ORDER')}
        />
        <StageGroup
          title="Materials" icon={<Boxes className="h-4 w-4" />}
          stages={order.stages.filter((s) => s.group === 'MATERIALS')}
          footer={
            order.bom && order.bom.shortItems > 0 ? (
              <button
                onClick={() => onJump('bom')}
                className="mt-2 flex w-full items-start gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-left"
              >
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span className="text-2xs leading-snug text-amber-900">
                  <strong>{order.bom.shortItems}</strong> of {order.bom.totalItems} material lines outstanding
                  {order.bom.topShortages[0] && (
                    <> — worst: {order.bom.topShortages[0].item} short by{' '}
                      {fmtNumber(order.bom.topShortages[0].shortQty)} {order.bom.topShortages[0].unit}</>
                  )}
                </span>
              </button>
            ) : order.bom ? (
              <p className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-2xs text-emerald-800">
                All {order.bom.totalItems} material lines issued.
              </p>
            ) : null
          }
        />
        <StageGroup
          title="Production" icon={<Scissors className="h-4 w-4" />}
          stages={order.stages.filter((s) => s.group === 'PRODUCTION')}
          footer={
            <div className="mt-2 space-y-1 rounded border border-ink-200 bg-ink-50 px-2 py-1.5 text-2xs">
              <Row label="Produced" value={`${fmtNumber(order.production.producedQty)} / ${fmtNumber(order.production.orderQty)}`} />
              <Row label="Remaining" value={fmtNumber(order.production.remainingQty)} />
              <Row label="Current rate" value={<Num value={order.production.dailyRate} suffix="/day" fallback="No data" />} />
              <Row
                label="Expected completion"
                value={
                  <span className={order.production.isBehindSchedule ? 'font-semibold text-red-600' : ''}>
                    {order.production.projectedCompletion
                      ? fmtDate(order.production.projectedCompletion)
                      : 'Not calculated'}
                  </span>
                }
              />
              {order.production.isBehindSchedule && (
                <p className="mt-1 rounded bg-red-100 px-1.5 py-1 font-medium text-red-800">
                  Behind schedule
                  {order.production.slipDays != null && order.production.slipDays > 0 &&
                    ` by ${order.production.slipDays} day${order.production.slipDays === 1 ? '' : 's'}`}
                  . Needs <Num value={order.production.requiredDailyRate} suffix="/day" />.
                </p>
              )}
            </div>
          }
        />
        <StageGroup
          title="Delivery" icon={<ShieldCheck className="h-4 w-4" />}
          stages={order.stages.filter((s) => s.group === 'DELIVERY')}
          footer={
            <div className="mt-2 space-y-1 rounded border border-ink-200 bg-ink-50 px-2 py-1.5 text-2xs">
              <Row label="Quality pass rate" value={<Num value={order.qualityPassPct} kind="percent" />} />
              <Row label="Packed" value={fmtNumber(qty('PACKED'))} />
              <Row label="Shipped" value={fmtNumber(qty('SHIPPED'))} />
            </div>
          }
        />
      </div>

      {/* ── Cut, stock and colour progress ───────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Cut Order" subtitle={`${(order.cutPercentage * 100).toFixed(1)}% allowance`} />
          <div className="space-y-2 p-4 text-sm">
            <Row label="Customer ordered" value={<Num value={order.stockDeduction.customerOrderQty} />} />
            <Row label="Usable stock" value={<Num value={order.stockDeduction.usableStockQty} />} />
            <Row label="Required production" value={<Num value={order.stockDeduction.requiredProductionQty} className="font-semibold" />} />
            <div className="border-t border-ink-100 pt-2">
              <Row label="Planned cut" value={<Num value={order.cutVariance.plannedCutQty} />} />
              <Row label="Actual cut" value={<Num value={order.cutVariance.actualCutQty} />} />
              <Row label="Variance" value={<Num value={order.cutVariance.variance} kind="variance" />} />
            </div>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Progress by colour" subtitle="So one lagging colour is visible, not averaged away" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  <th className="th">Colour</th>
                  <th className="th text-right">Ordered</th>
                  <th className="th text-right">Cut</th>
                  <th className="th text-right">Produced</th>
                  <th className="th text-right">Packed</th>
                  <th className="th w-32">Complete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {order.colorProgress.map((c) => (
                  <tr key={c.colorId}>
                    <td className="td font-medium">{c.colorName}</td>
                    <td className="td text-right"><Num value={c.ordered} /></td>
                    <td className="td text-right"><Num value={c.cut} /></td>
                    <td className="td text-right"><Num value={c.produced} /></td>
                    <td className="td text-right"><Num value={c.packed} /></td>
                    <td className="td"><ProgressBar value={c.completionPct} showLabel /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ── Notes carried over from the workbook ─────────────────────────── */}
      {(order.notes.general || order.notes.spread || order.notes.cut ||
        order.notes.packing || order.notes.external) && (
        <Card>
          <CardHeader title="Instructions & notes" subtitle="Carried over from the order sheet" />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <NoteBlock label="General" text={order.notes.general} />
            <NoteBlock label="Spread" text={order.notes.spread} />
            <NoteBlock label="Cut" text={order.notes.cut} />
            <NoteBlock label="Packing" text={order.notes.packing} />
            <NoteBlock label="External" text={order.notes.external} />
          </div>
        </Card>
      )}
    </div>
  );
}

function StageGroup({
  title, icon, stages, footer,
}: {
  title: string;
  icon: React.ReactNode;
  stages: OrderDetailDto['stages'];
  footer?: React.ReactNode;
}) {
  const active = stages.filter((s) => s.totalTasks > 0);
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-ink-200 px-4 py-2.5">
        <span className="text-ink-400">{icon}</span>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
      </div>
      <div className="p-3">
        <ul className="space-y-1.5">
          {active.length === 0 && <li className="text-xs text-ink-400">No tasks in this group.</li>}
          {active.map((s) => (
            <li key={s.stageKey} className="flex items-center gap-2">
              <StageDot status={s.status} size="sm" />
              <span className="min-w-0 flex-1 truncate text-xs text-ink-700">{s.label}</span>
              <span className="tnum shrink-0 text-2xs text-ink-400">
                {s.completedTasks}/{s.totalTasks}
              </span>
            </li>
          ))}
        </ul>
        {footer}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-ink-500">{label}</span>
      <span className="text-right text-ink-900">{value}</span>
    </div>
  );
}

function DateRow({
  label, value, emphasis, trailing,
}: {
  label: string; value: string | null; emphasis?: boolean; trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2.5">
      <span className="text-xs text-ink-500">{label}</span>
      <div className="text-right">
        <span className={clsx('text-sm', emphasis ? 'font-semibold text-ink-900' : 'text-ink-700')}>
          {fmtDate(value)}
        </span>
        {trailing && <div>{trailing}</div>}
      </div>
    </div>
  );
}

function NoteBlock({ label, text }: { label: string; text: string | null }) {
  if (!text?.trim()) return null;
  return (
    <div>
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
      <div className="rounded border border-ink-200 bg-ink-50 px-3 py-2 text-sm leading-relaxed text-ink-800">
        <FreeText text={text} />
      </div>
    </div>
  );
}

export { STAGE_META, type StageKey };

/** One of the four material states, as a count out of the total. */
function MaterialStat({
  label, value, total, tone,
}: {
  label: string; value: number; total: number; tone: 'emerald' | 'blue' | 'red' | 'slate';
}) {
  const colour = {
    emerald: value > 0 ? 'text-emerald-700' : 'text-ink-400',
    blue: value > 0 ? 'text-blue-700' : 'text-ink-400',
    red: value > 0 ? 'text-red-700' : 'text-ink-400',
    slate: value > 0 ? 'text-ink-700' : 'text-ink-400',
  }[tone];

  return (
    <div>
      <p className="label">{label}</p>
      <p className={clsx('tnum text-xl font-semibold', colour)}>
        {value}
        <span className="ml-1 text-xs font-normal text-ink-400">of {total}</span>
      </p>
    </div>
  );
}
