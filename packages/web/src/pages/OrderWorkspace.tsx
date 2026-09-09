/**
 * The order workspace.
 *
 * Phase 3 changed what this page *is*. It used to be sixteen equal tabs, which
 * assumes the person opening it already knows the factory's process. It is now
 * the factory's own eighteen steps down the left-hand side, with exactly one of
 * them lit up, and the screen for that step in the middle.
 *
 * The tab strip is still here, one click away under "All screens", because
 * somebody who knows exactly where they are going should not be walked through
 * a wizard. But the guided rail is what opens, and it is what a new coordinator
 * follows on their first day.
 */

import { useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, LayoutGrid, ListOrdered } from 'lucide-react';
import { fmtDate, type OrderStepState, type OrderTabKey } from '@opsflow/shared';
import { api } from '../lib/api';
import {
  ProgressBar, HealthBadge, StatusBadge, PriorityBadge,
  Spinner, ErrorNote, TabStrip,
} from '../components/ui';

import { OverviewTab } from './order-tabs/OverviewTab';
import { DetailsTab } from './order-tabs/DetailsTab';
import { QuantityTab } from './order-tabs/QuantityTab';
import { TasksTab } from './order-tabs/TasksTab';
import { BomTab } from './order-tabs/BomTab';
import { MaterialsTab } from './order-tabs/MaterialsTab';
import { MarkerTab } from './order-tabs/MarkerTab';
import { ProductionTab } from './order-tabs/ProductionTab';
import { ExternalTab } from './order-tabs/ExternalTab';
import { QualityTab } from './order-tabs/QualityTab';
import { PackingTab } from './order-tabs/PackingTab';
import { CostingTab } from './order-tabs/CostingTab';
import { ActivityTab } from './order-tabs/ActivityTab';
import { CustomerReferenceTab } from './order-tabs/CustomerReferenceTab';
import { InstructionsTab } from './order-tabs/InstructionsTab';
import { StockTab } from './order-tabs/StockTab';
import { ProformaTab } from './order-tabs/ProformaTab';
import { OrderFollowUpTab } from './order-tabs/OrderFollowUpTab';
import { StepRail, StepHeader } from './order-tabs/StepRail';
import { DocumentsTab } from './order-tabs/DocumentsTab';
import { ProgressStatusTab } from './order-tabs/ProgressStatusTab';
import { OrderAuditTab } from './order-tabs/OrderAuditTab';
import { DatabaseTab } from './order-tabs/DatabaseTab';
import { InvoiceTab } from './order-tabs/InvoiceTab';

/**
 * The workspace's screens, taken from @opsflow/shared rather than declared
 * again here. Every step names the screen it opens, and a step pointing at a
 * screen that does not exist navigates nowhere — silently. Deriving both from
 * one list makes that a compile error instead.
 */
type TabKey = OrderTabKey;

export function OrderWorkspacePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) || 'overview';
  const [showAllTabs, setShowAllTabs] = useState(false);

  const { data: order, isLoading, error, refetch } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.orders.get(id),
  });

  // The rail is a second query on purpose: it refreshes on its own whenever a
  // step changes, without re-fetching the whole order graph behind every tab.
  const { data: stepsRes } = useQuery({
    queryKey: ['order-steps', id],
    queryFn: () => api.steps.list(id),
    enabled: Boolean(order),
  });
  const steps = stepsRes?.data;

  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', key);
    setParams(next, { replace: true });
  };

  if (isLoading) return <Spinner label="Loading order…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;
  if (!order) return null;

  const criticalCount = order.alerts.filter((a) => a.severity === 'CRITICAL').length;
  const warningCount = order.alerts.filter((a) => a.severity === 'WARNING').length;

  // The step whose screen is showing. Several steps share a screen (the cut
  // order and the main order are both the Quantity tab), so the current step
  // wins the tie — that is the one the coordinator is actually on.
  const stepForTab: OrderStepState | undefined = steps
    ? steps.steps.find((s) => s.tab === tab && s.isCurrent)
      ?? steps.steps.find((s) => s.tab === tab)
    : undefined;

  const tabs: Array<{ key: TabKey; label: string; badge?: number; tone?: 'red' | 'amber' }> = [
    { key: 'overview',   label: 'Overview', badge: criticalCount + warningCount, tone: criticalCount > 0 ? 'red' : 'amber' },
    { key: 'reference',  label: 'Customer Reference' },
    { key: 'details',    label: 'Order Details' },
    { key: 'quantity',   label: 'Quantity' },
    { key: 'proforma',   label: 'Proforma Invoice' },
    { key: 'progress',   label: 'Progress Status' },
    { key: 'tasks',      label: 'Workflow', badge: order.counts.overdueTasks, tone: 'red' },
    { key: 'cutting',    label: 'Cutting & Marker' },
    { key: 'materials',  label: 'Materials', badge: order.materials?.shortCount ?? 0, tone: 'red' },
    { key: 'bom',        label: 'BOM', badge: order.bom?.shortItems ?? 0, tone: 'amber' },
    { key: 'instructions', label: 'Custom Instructions' },
    { key: 'external',   label: 'External Ops', badge: order.counts.openExternalOps },
    { key: 'approvals',  label: 'Approvals', badge: order.counts.pendingApprovals, tone: 'red' },
    { key: 'production', label: 'Production' },
    { key: 'quality',    label: 'Quality' },
    { key: 'packing',    label: 'Packing' },
    { key: 'stock',      label: 'Stock' },
    { key: 'followup',   label: 'Follow-up', badge: order.blockers.length, tone: 'red' },
    { key: 'audit',      label: 'Audit' },
    { key: 'costing',    label: 'Costing' },
    { key: 'database',   label: 'Database' },
    { key: 'invoice',    label: 'Invoice' },
    { key: 'shipping',   label: 'Shipping' },
    { key: 'documents',  label: 'Documents', badge: order.counts.attachments },
    { key: 'activity',   label: 'Activity' },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header — questions 1–3 of the brief answered before you scroll. */}
      <div className="shrink-0 border-b border-ink-200 bg-white">
        <div className="px-5 pt-3">
          <Link to="/orders" className="mb-2 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800">
            <ChevronLeft className="h-3.5 w-3.5" /> Orders
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl font-semibold uppercase tracking-tight text-ink-900">
                  {order.orderName}
                </h1>
                <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-ink-700">
                  PO {order.poNumber}
                </span>
                <StatusBadge status={order.status} />
                <HealthBadge health={order.health} />
                <PriorityBadge priority={order.priority} />
              </div>

              {/* The nine facts a coordinator checks before doing anything.
                  Quantity and delivery are here because "how many, by when" is
                  the question behind every other one. */}
              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                <HeaderFact label="Client" value={order.client.name} />
                <HeaderFact label="Style" value={order.styleNumber} />
                <HeaderFact label="Coordinator" value={order.coordinator?.name} />
                <HeaderFact label="Factory" value={order.externalFactory?.name ?? order.factory?.name} />
                <HeaderFact label="Fabric" value={order.fabric} />
                <HeaderFact
                  label="Quantity"
                  value={order.stockDeduction.customerOrderQty
                    ? `${order.stockDeduction.customerOrderQty.toLocaleString()} pcs`
                    : null}
                />
                <HeaderFact label="Delivery" value={fmtDate(order.requiredDeliveryDate)} />
                <HeaderFact label="Season" value={order.season} />
              </dl>
            </div>

            <div className="w-full max-w-xs shrink-0">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  Order Progress
                </span>
                <span className="tnum text-lg font-semibold text-ink-900">{order.progressPct}%</span>
              </div>
              <ProgressBar value={order.progressPct} height="lg" />
              <p className="mt-1 text-2xs text-ink-500">
                Calculated from {order.stages.reduce((a, s) => a + s.completedTasks, 0)} of{' '}
                {order.stages.reduce((a, s) => a + s.totalTasks, 0)} workflow tasks — never typed in.
              </p>
            </div>
          </div>

          {/* The next thing to do, stated once, at the top. */}
          {steps?.current && (
            <button
              onClick={() => setTab(steps.current!.tab)}
              className="mt-3 flex w-full items-center gap-2 rounded-md border border-accent-200 bg-accent-50 px-3 py-2 text-left transition-colors hover:bg-accent-100"
            >
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-600 text-[10px] font-semibold text-white">
                {steps.current.order}
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-accent-900">
                  Next: {steps.current.label}
                </span>
                {steps.current.missing && (
                  <span className="ml-2 text-xs text-accent-800">— {steps.current.missing}</span>
                )}
              </span>
              <span className="shrink-0 text-xs font-medium text-accent-700">Go →</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 px-5">
          <button
            onClick={() => setShowAllTabs((v) => !v)}
            className="mt-1 inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800"
            title={showAllTabs ? 'Hide the full tab list' : 'Show every screen'}
          >
            {showAllTabs ? <ListOrdered className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
            {showAllTabs ? 'Guided steps' : 'All screens'}
          </button>
          {showAllTabs && (
            <div className="min-w-0 flex-1">
              <TabStrip tabs={tabs} active={tab} onChange={setTab} />
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {steps && !showAllTabs && (
          <StepRail
            steps={steps}
            activeKey={stepForTab?.key ?? null}
            onJump={(s: OrderStepState) => setTab(s.tab)}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto bg-ink-50">
          {/* What this step is for, who does it, what is missing, and the one
              button that moves the order on. Above whatever screen it opens. */}
          {steps && stepForTab && tab !== 'overview' && (
            <div className="px-5 pt-5">
              <StepHeader orderId={order.id} steps={steps} step={stepForTab} />
            </div>
          )}

          {tab === 'overview'     && <OverviewTab order={order} onJump={setTab} />}
          {tab === 'reference'    && <CustomerReferenceTab orderId={order.id} />}
          {tab === 'details'      && <DetailsTab order={order} />}
          {tab === 'quantity'     && <QuantityTab order={order} />}
          {tab === 'proforma'     && <ProformaTab order={order} />}
          {tab === 'tasks'        && <TasksTab order={order} />}
          {tab === 'cutting'      && <MarkerTab order={order} />}
          {tab === 'materials'    && <MaterialsTab order={order} />}
          {tab === 'bom'          && <BomTab order={order} />}
          {tab === 'instructions' && <InstructionsTab orderId={order.id} />}
          {(tab === 'external' || tab === 'approvals') && <ExternalTab order={order} focus={tab} />}
          {tab === 'production'   && <ProductionTab order={order} />}
          {tab === 'quality'      && <QualityTab order={order} />}
          {(tab === 'packing' || tab === 'shipping') && <PackingTab order={order} focus={tab} />}
          {tab === 'stock'        && <StockTab order={order} />}
          {tab === 'progress'     && <ProgressStatusTab order={order} steps={steps} onJump={setTab} />}
          {tab === 'audit'        && <OrderAuditTab order={order} />}
          {tab === 'database'     && <DatabaseTab orderId={order.id} />}
          {tab === 'invoice'      && <InvoiceTab order={order} />}
          {tab === 'followup'     && <OrderFollowUpTab order={order} steps={steps} onJump={setTab} />}
          {tab === 'costing'      && <CostingTab order={order} />}
          {tab === 'documents'    && <DocumentsTab orderId={order.id} />}
          {tab === 'activity'     && <ActivityTab orderId={order.id} />}
        </div>
      </div>
    </div>
  );
}

function HeaderFact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-400">{label}:</dt>
      <dd className="font-medium text-ink-800">{value || '—'}</dd>
    </div>
  );
}
