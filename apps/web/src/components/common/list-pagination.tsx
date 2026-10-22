'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clampPage, pageRange, pageWindow } from '@/lib/pagination';

const SELECT =
  'h-8 rounded-lg border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

export type ListPaginationProps = Readonly<{
  page: number;
  pageSize: number;
  pageSizes: readonly number[];
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}>;

/**
 * The pagination bar of every list: "21–40 of 142", rows per page, first/previous/numbers/next/last
 * and a box to jump to any page. Strings are in the `List` namespace. It only reports what the
 * user chose; the screen owns the state (the URL).
 */
export function ListPagination({
  page,
  pageSize,
  pageSizes,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: ListPaginationProps) {
  const t = useTranslations('List');
  const sizeId = useId();
  const jumpId = useId();
  const [jump, setJump] = useState('');
  const { from, to } = pageRange(page, pageSize, total);

  const submitJump = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{1,6}$/.test(jump)) return;
    onPageChange(clampPage(Number(jump), totalPages)); // 0 and "9999" land on the first/last page
    setJump('');
  };

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid="list-pagination"
    >
      <p className="text-sm text-muted-foreground" data-testid="list-range">
        {t('range', { from, to, total })}
      </p>
      <div className="flex items-center gap-2">
        <Label htmlFor={sizeId} className="text-sm font-normal text-muted-foreground">
          {t('pageSize')}
        </Label>
        <select
          id={sizeId}
          className={SELECT}
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {pageSizes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {totalPages > 0 && (
        <nav aria-label={t('pagination')} className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('first')}
            disabled={page <= 1}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('previous')}
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          {pageWindow(page, totalPages).map((item, i, all) =>
            item === 'gap' ? (
              <span
                key={`gap-after-${all[i - 1]}`}
                aria-hidden
                className="px-1 text-muted-foreground"
              >
                …
              </span>
            ) : (
              <Button
                key={item}
                type="button"
                size="icon"
                variant={item === page ? 'default' : 'outline'}
                aria-label={t('goToPage', { page: item })}
                aria-current={item === page ? 'page' : undefined}
                onClick={() => item !== page && onPageChange(item)}
              >
                {item}
              </Button>
            ),
          )}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('next')}
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('last')}
            disabled={page >= totalPages}
            onClick={() => onPageChange(totalPages)}
          >
            <ChevronsRight aria-hidden />
          </Button>
        </nav>
      )}
      {totalPages > 1 && (
        <form className="flex items-center gap-2" onSubmit={submitJump}>
          <Label htmlFor={jumpId} className="text-sm font-normal text-muted-foreground">
            {t('jumpLabel', { totalPages })}
          </Label>
          <Input
            id={jumpId}
            inputMode="numeric"
            autoComplete="off"
            className="h-8 w-20"
            value={jump}
            onChange={(e) => setJump(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <Button type="submit" variant="outline" size="sm" disabled={jump === ''}>
            {t('jumpButton')}
          </Button>
        </form>
      )}
    </div>
  );
}
