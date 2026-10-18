import { INVOICE_STATUS_LABEL, type InvoiceStatus } from '@opsflow/shared';
import { clsx } from './ui';

/** Draft amber, issued blue until it is sent and then green, void red — the one mapping every screen uses. */
export function InvoiceStatusChip({ status, sentAt, className }: { status: InvoiceStatus; sentAt?: string | null; className?: string }) {
  const tone = status === 'ISSUED'
    ? (sentAt ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-blue-50 text-blue-700 ring-blue-600/20')
    : status === 'VOID' ? 'bg-red-50 text-red-700 ring-red-600/20'
    : 'bg-amber-50 text-amber-800 ring-amber-600/20';
  return <span className={clsx('chip', tone, className)}>{INVOICE_STATUS_LABEL[status]}{status === 'ISSUED' && sentAt ? ' · sent' : ''}</span>;
}
