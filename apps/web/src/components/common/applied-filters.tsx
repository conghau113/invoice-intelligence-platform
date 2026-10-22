'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

export type AppliedFilter = { key: string; label: string; onRemove: () => void };

/** Removable chips for the filters in force, plus "clear all". Renders nothing when there are none. */
export function AppliedFilters({
  filters,
  onClearAll,
}: Readonly<{ filters: AppliedFilter[]; onClearAll: () => void }>) {
  const t = useTranslations('List');
  if (filters.length === 0) return null;
  return (
    <ul
      aria-label={t('appliedFilters')}
      className="flex flex-wrap items-center gap-2"
      data-testid="applied-filters"
    >
      {filters.map((f) => (
        <li key={f.key}>
          <span className="inline-flex items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2 text-xs font-medium">
            {f.label}
            <button
              type="button"
              aria-label={t('removeFilter', { name: f.label })}
              className="inline-flex size-5 items-center justify-center rounded hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={f.onRemove}
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        </li>
      ))}
      <li>
        <Button type="button" variant="ghost" size="sm" onClick={onClearAll}>
          {t('clearAll')}
        </Button>
      </li>
    </ul>
  );
}
