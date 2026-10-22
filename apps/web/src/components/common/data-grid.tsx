'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { HeaderCell, type Column, type TableSort } from './data-table';

const DEFAULT_COLUMN_WIDTH = 160;

/**
 * The table of docs/ui/UI_TABLE_SPEC.md. A panel whose height comes from the space its parent
 * gives it (never from the number of rows), made of four stacked parts:
 *
 *   viewport   rows and header; the only part that scrolls up and down
 *   strip      a horizontal scrollbar that is always there, even with nothing to scroll
 *   footer     pinned to the bottom (totals, pagination)
 *
 * The header is `position: sticky` inside the viewport, in the same scroll container as the rows,
 * so columns stay aligned without any script. The viewport's own horizontal scrollbar is pushed
 * out of sight (it would appear only when the table overflows, and move with the row count); the
 * strip, kept in step with `scrollLeft`, is the one the user sees.
 *
 * Loading shows skeleton rows, and `state` (empty, error) replaces the rows: the header, the
 * strip and the footer never move.
 */
export function DataGrid<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowAttrs,
  sort,
  onSort,
  sortLabel,
  loading = false,
  loadingRows = 8,
  state,
  footer,
  busy = false,
  dimmed = false,
}: Readonly<{
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowAttrs?: (row: T) => Record<`data-${string}`, string>;
  sort?: TableSort;
  onSort?: (key: string) => void;
  sortLabel?: (column: Column<T>) => string;
  loading?: boolean;
  loadingRows?: number;
  /** Shown in place of the rows (empty list, error). */
  state?: ReactNode;
  footer: ReactNode;
  busy?: boolean;
  /** Rows are from the previous page and the next one is loading. */
  dimmed?: boolean;
}>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const stripWrapRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);

  const minWidth = columns.reduce((sum, c) => sum + (c.width ?? DEFAULT_COLUMN_WIDTH), 0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const table = tableRef.current;
    const wrap = stripWrapRef.current;
    const strip = stripRef.current;
    const spacer = spacerRef.current;
    if (!viewport || !table || !wrap || !strip || !spacer) return;

    // Sizes of the browser's own scrollbars (0 for overlay scrollbars). Written straight to the
    // elements: going through React state would render, resize, and measure again in a loop.
    const measure = () => {
      const horizontalBar = viewport.offsetHeight - viewport.clientHeight;
      const verticalBar = viewport.offsetWidth - viewport.clientWidth;
      // The viewport is made taller than its clip box by exactly its own horizontal scrollbar,
      // which is cut off below the panel: the user sees the strip's scrollbar only.
      viewport.style.bottom = `${-horizontalBar}px`;
      // The strip is as wide as the rows' visible area (the vertical scrollbar is not part of it)...
      wrap.style.paddingRight = `${verticalBar}px`;
      // ...and scrolls exactly as far as the viewport does; with nothing to scroll it has no range.
      spacer.style.width = `${viewport.scrollWidth}px`;
      strip.scrollLeft = viewport.scrollLeft;
    };
    // Each side copies the other's position. Setting an equal value fires no event, so the echo
    // stops after one round and there is no flag to forget to reset.
    const fromViewport = () => {
      if (strip.scrollLeft !== viewport.scrollLeft) strip.scrollLeft = viewport.scrollLeft;
    };
    const fromStrip = () => {
      if (viewport.scrollLeft !== strip.scrollLeft) viewport.scrollLeft = strip.scrollLeft;
    };
    viewport.addEventListener('scroll', fromViewport, { passive: true });
    strip.addEventListener('scroll', fromStrip, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); // window resize, zoom, sidebar collapse
    observer.observe(table); // columns or rows changed the content size
    measure();
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', fromViewport);
      strip.removeEventListener('scroll', fromStrip);
    };
  }, []);

  return (
    <div
      data-testid="table-panel"
      aria-busy={busy}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={viewportRef}
          data-testid="table-viewport"
          // A scrollable region must be reachable by keyboard.
          tabIndex={0}
          role="region"
          aria-label={caption}
          className="absolute inset-x-0 top-0 bottom-0 overflow-auto outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
        >
          <div className="flex min-h-full flex-col">
            <table
              ref={tableRef}
              className="w-full flex-none table-fixed caption-bottom text-sm"
              style={{ minWidth }}
            >
              <caption className="sr-only">{caption}</caption>
              <colgroup>
                {columns.map((c) => (
                  <col key={c.key} style={{ width: c.width ?? DEFAULT_COLUMN_WIDTH }} />
                ))}
              </colgroup>
              <TableHeader className="sticky top-0 z-10 bg-table-header shadow-[0_1px_0_var(--border)]">
                <TableRow className="hover:bg-transparent">
                  {columns.map((c) => (
                    <HeaderCell
                      key={c.key}
                      column={c}
                      sort={sort}
                      onSort={onSort}
                      sortLabel={sortLabel}
                      className="bg-table-header"
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody className={cn(dimmed && 'opacity-60 transition-opacity')}>
                {loading
                  ? Array.from({ length: loadingRows }, (_, r) => (
                      <TableRow key={r} className="hover:bg-transparent even:bg-table-row-alt">
                        {columns.map((c) => (
                          <TableCell key={c.key}>
                            <Skeleton className="h-4 w-3/4" />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  : state === undefined &&
                    rows.map((row) => (
                      <TableRow
                        key={rowKey(row)}
                        className="even:bg-table-row-alt hover:bg-table-row-hover"
                        {...rowAttrs?.(row)}
                      >
                        {columns.map((c) => (
                          <TableCell
                            key={c.key}
                            title={c.title?.(row)}
                            className={cn('truncate', c.numeric && 'text-right tabular-nums')}
                          >
                            {c.cell(row)}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
              </TableBody>
            </table>
            {state !== undefined && !loading && (
              <div
                className="flex flex-1 items-center justify-center p-6"
                data-testid="table-state"
              >
                {state}
              </div>
            )}
          </div>
        </div>
      </div>
      <div ref={stripWrapRef} className="flex-none border-t" data-testid="table-hscroll-wrap">
        <div
          ref={stripRef}
          data-testid="table-hscroll"
          // For the mouse and touch. The rows' viewport is the keyboard stop (arrow keys scroll it
          // and this strip follows), so a second tab stop and a second announcement would be noise.
          aria-hidden
          className="h-scroll-strip h-2.5"
        >
          <div ref={spacerRef} className="h-px" />
        </div>
      </div>
      <div data-testid="table-footer" className="flex-none border-t px-3 py-2">
        {footer}
      </div>
    </div>
  );
}
