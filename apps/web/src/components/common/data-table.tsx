import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type Column<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Amounts and counts: right-aligned with tabular figures. */
  numeric?: boolean;
  /** The column can be sorted: its header becomes a button (see `sort` and `onSort`). */
  sortable?: boolean;
  /** Width in px in a DataGrid (columns keep it and the grid scrolls sideways instead of squeezing). */
  width?: number;
  /** Full text of a cell shown as ellipsis, offered as a tooltip. */
  title?: (row: T) => string | undefined;
};

export type TableSort = { key: string; direction: 'asc' | 'desc' };

/** One header cell: plain text, or a sort button with `aria-sort` for a `sortable` column. */
export function HeaderCell<T>({
  column: c,
  sort,
  onSort,
  sortLabel,
  className,
}: Readonly<{
  column: Column<T>;
  sort?: TableSort;
  onSort?: (key: string) => void;
  sortLabel?: (column: Column<T>) => string;
  className?: string;
}>) {
  return (
    <TableHead
      scope="col"
      className={cn(c.numeric && 'text-right', className)}
      aria-sort={
        c.sortable
          ? sort?.key === c.key
            ? sort.direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
          : undefined
      }
    >
      {c.sortable && onSort ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 uppercase hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={sortLabel?.(c)}
          onClick={() => onSort(c.key)}
        >
          {c.header}
          {sort?.key === c.key ? (
            sort.direction === 'asc' ? (
              <ArrowUp aria-hidden className="size-3" />
            ) : (
              <ArrowDown aria-hidden className="size-3" />
            )
          ) : (
            <ArrowUpDown aria-hidden className="size-3 opacity-50" />
          )}
        </button>
      ) : (
        c.header
      )}
    </TableHead>
  );
}

/** Static, accessible table. Sorting, filtering and paging belong to the screen that uses it. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowAttrs,
  sort,
  onSort,
  sortLabel,
}: Readonly<{
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** `data-*` attributes for a row (test ids, state). */
  rowAttrs?: (row: T) => Record<`data-${string}`, string>;
  /** The column the rows are sorted by now, for `aria-sort` and the arrow. */
  sort?: TableSort;
  /** Called with the key of the sortable column whose header was activated. */
  onSort?: (key: string) => void;
  /** Accessible name of a sort button, e.g. "Sort by Uploaded at" (translated by the caller). */
  sortLabel?: (column: Column<T>) => string;
}>) {
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((c) => (
            <HeaderCell
              key={c.key}
              column={c}
              sort={sort}
              onSort={onSort}
              sortLabel={sortLabel}
              className={undefined}
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rowKey(row)} {...rowAttrs?.(row)}>
            {columns.map((c) => (
              <TableCell key={c.key} className={cn(c.numeric && 'text-right tabular-nums')}>
                {c.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
