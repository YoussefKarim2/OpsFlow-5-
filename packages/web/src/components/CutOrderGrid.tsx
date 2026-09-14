/**
 * The cut order, shown where the work is being sent out.
 *
 * The External Order screen says what leaves the factory and to whom; the cut
 * order says how many pieces of each colour and size there are to send. Those
 * two belong on one screen — reading a printing quantity without the cut
 * quantity beside it means opening another tab and remembering a number.
 *
 * Read-only on purpose. The cut order is generated from the main order and its
 * allowance, and editing it belongs on the Cut Order step where that
 * calculation lives. A second editable copy of the same grid is how the two
 * come to disagree.
 */

import { fmtNumber, type MatrixResponseDto, QtyLedger } from '@opsflow/shared';
import { Card, CardHeader, EmptyState, Spinner } from './ui';

export function CutOrderGrid({
  data, isLoading, onOpenCutOrder,
}: {
  data: MatrixResponseDto | undefined;
  isLoading?: boolean;
  /** Takes the user to the step that can generate it. */
  onOpenCutOrder?: () => void;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader title="Cut order" subtitle="The quantities this external work is based on." />
        <div className="p-6"><Spinner label="Loading the cut order…" /></div>
      </Card>
    );
  }

  const matrix = data?.matrices?.[QtyLedger.CUT];
  const total = matrix?.grandTotal ?? 0;

  // No cut order yet is an ordinary state, not an error: it is generated after
  // the main order is entered, and this screen is often opened before that.
  if (!matrix || total === 0) {
    return (
      <Card>
        <CardHeader title="Cut order" subtitle="The quantities this external work is based on." />
        <EmptyState
          title="No cut order yet"
          detail="The cut order is calculated from the main order and its cutting allowance. Once it exists it appears here, so the quantities sent out can be checked against it."
          action={onOpenCutOrder
            ? <button className="btn-secondary btn-sm" onClick={onOpenCutOrder}>Open the Cut Order step</button>
            : undefined}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Cut order"
        subtitle={`${fmtNumber(total)} pieces across ${matrix.colors.length} colour${matrix.colors.length === 1 ? '' : 's'} and ${matrix.sizes.length} size${matrix.sizes.length === 1 ? '' : 's'} — the quantities this external work is based on.`}
        action={onOpenCutOrder
          ? <button className="btn-ghost btn-sm" onClick={onOpenCutOrder}>Open the Cut Order step</button>
          : undefined}
      />
      {/* Wide grids scroll inside their own box rather than stretching the page. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50">
              <th className="sticky left-0 z-10 bg-ink-50 px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-ink-500">
                Colour
              </th>
              {matrix.sizes.map((s) => (
                <th key={s.id} className="px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  {s.name}
                </th>
              ))}
              <th className="bg-ink-100 px-3 py-2 text-right text-2xs font-semibold uppercase tracking-wider text-ink-600">
                Total
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {matrix.colors.map((c) => {
              const swatch = data?.colors.find((x) => x.id === c.id)?.hex;
              return (
                <tr key={c.id}>
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-1.5 text-sm font-medium text-ink-800">
                    <span className="inline-flex items-center gap-2">
                      {swatch && (
                        <span
                          className="inline-block h-3 w-3 shrink-0 rounded-sm ring-1 ring-ink-300/60"
                          style={{ backgroundColor: swatch }}
                        />
                      )}
                      {c.name}
                    </span>
                  </td>
                  {matrix.sizes.map((s) => {
                    const qty = matrix.cells[c.id]?.[s.id] ?? 0;
                    return (
                      <td
                        key={s.id}
                        className={`px-2 py-1.5 text-center text-sm tnum ${qty === 0 ? 'text-ink-300' : 'text-ink-800'}`}
                      >
                        {qty === 0 ? '·' : fmtNumber(qty)}
                      </td>
                    );
                  })}
                  <td className="bg-ink-50 px-3 py-1.5 text-right text-sm font-semibold tnum text-ink-900">
                    {fmtNumber(matrix.rowTotals[c.id] ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink-300 bg-ink-50">
              <td className="sticky left-0 z-10 bg-ink-50 px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-ink-600">
                Total
              </td>
              {matrix.sizes.map((s) => (
                <td key={s.id} className="px-2 py-2 text-center text-sm font-semibold tnum text-ink-800">
                  {fmtNumber(matrix.colTotals[s.id] ?? 0)}
                </td>
              ))}
              <td className="bg-ink-100 px-3 py-2 text-right text-sm font-bold tnum text-ink-900">
                {fmtNumber(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
