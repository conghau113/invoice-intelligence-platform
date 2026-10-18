import type { Column } from '@/components/common/data-table';
import { StatusBadge, type DocumentStatus } from '@/components/common/status-badge';
import { formatDate, formatMoney } from '@/i18n/format';
import type { SampleInvoice } from './sample-data';

// Module-level, not inside the page component: cell renderers keep a stable identity.
function NumberCell({ value }: Readonly<{ value: string }>) {
  return <span className="font-mono">{value}</span>;
}

function StatusCell({ status, label }: Readonly<{ status: DocumentStatus; label: string }>) {
  return <StatusBadge status={status} label={label} />;
}

export function invoiceColumns({
  labels,
  statusLabel,
  locale,
}: Readonly<{
  labels: Record<'number' | 'seller' | 'date' | 'total' | 'status', string>;
  statusLabel: (status: DocumentStatus) => string;
  locale: string;
}>): Column<SampleInvoice>[] {
  return [
    { key: 'number', header: labels.number, cell: (r) => <NumberCell value={r.number} /> },
    { key: 'seller', header: labels.seller, cell: (r) => r.seller },
    { key: 'date', header: labels.date, cell: (r) => formatDate(r.issuedAt, locale) },
    {
      key: 'total',
      header: labels.total,
      numeric: true,
      cell: (r) => formatMoney(r.totalVnd, 'VND', locale),
    },
    {
      key: 'status',
      header: labels.status,
      cell: (r) => <StatusCell status={r.status} label={statusLabel(r.status)} />,
    },
  ];
}
