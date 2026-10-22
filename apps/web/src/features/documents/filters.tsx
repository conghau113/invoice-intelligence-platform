'use client';

import { useTranslations } from 'next-intl';
import { DOCUMENT_STATUSES } from '@/components/common/status-badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SOURCE_TYPES, type ListParams } from './list-params';

const SELECT =
  'h-9 rounded-lg border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

/** Every change replaces the filter and goes back to page 1 (page 7 of the old filter means nothing now). */
export function Filters({
  params,
  onChange,
}: Readonly<{ params: ListParams; onChange: (next: ListParams) => void }>) {
  const t = useTranslations('Documents');
  const ts = useTranslations('Status');
  const set = (patch: Partial<ListParams>) => {
    const next = { ...params, ...patch };
    next.page = 1;
    for (const key of ['status', 'type', 'from', 'to'] as const) {
      if (next[key] === undefined || next[key] === '') delete next[key];
    }
    onChange(next);
  };
  return (
    <form
      role="search"
      aria-label={t('filters')}
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-status">{t('status')}</Label>
        <select
          id="f-status"
          className={SELECT}
          value={params.status ?? ''}
          onChange={(e) => set({ status: DOCUMENT_STATUSES.find((s) => s === e.target.value) })}
        >
          <option value="">{t('allStatuses')}</option>
          {DOCUMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ts(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-type">{t('type')}</Label>
        <select
          id="f-type"
          className={SELECT}
          value={params.type ?? ''}
          onChange={(e) => set({ type: SOURCE_TYPES.find((s) => s === e.target.value) })}
        >
          <option value="">{t('allTypes')}</option>
          {SOURCE_TYPES.map((s) => (
            <option key={s} value={s}>
              {t(`types.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-from">{t('from')}</Label>
        <Input
          id="f-from"
          type="date"
          className="w-40"
          value={params.from ?? ''}
          max={params.to}
          onChange={(e) => set({ from: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="f-to">{t('to')}</Label>
        <Input
          id="f-to"
          type="date"
          className="w-40"
          value={params.to ?? ''}
          min={params.from}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>
    </form>
  );
}
