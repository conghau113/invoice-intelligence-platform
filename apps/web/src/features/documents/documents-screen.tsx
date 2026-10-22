'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import { AppliedFilters, type AppliedFilter } from '@/components/common/applied-filters';
import type { Column } from '@/components/common/data-table';
import { DataGrid } from '@/components/common/data-grid';
import { PageLayout } from '@/components/common/page-layout';
import { ListPageHeader } from '@/components/common/list-page-header';
import { ListPagination } from '@/components/common/list-pagination';
import { StatePanel } from '@/components/common/state-panel';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/i18n/format';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { clampPage } from '@/lib/pagination';
import { Filters } from './filters';
import type { DocumentRow } from './list-client';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  hasFilters,
  parseListParams,
  toQuery,
  type ListParams,
  type PageSize,
} from './list-params';
import { QueryProvider } from './query-provider';
import { useDocumentList } from './use-document-list';

export function DocumentsScreen() {
  return (
    <QueryProvider>
      <List />
    </QueryProvider>
  );
}

const withoutFilters = (p: ListParams): ListParams => ({
  sort: p.sort,
  page: 1,
  pageSize: p.pageSize,
});

function List() {
  const t = useTranslations('Documents');
  const tl = useTranslations('List');
  const ts = useTranslations('Status');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  // The URL is the state: reload, back and a shared link all land on the same view.
  const params = useMemo(() => parseListParams(search), [search]);
  const go = (next: ListParams, push: boolean) => {
    const target = { pathname, query: toQuery(next) };
    if (push) router.push(target);
    else router.replace(target);
  };
  const { data, error, isPending, isFetching, isPlaceholderData, refetch } =
    useDocumentList(params);

  // The list can shrink under the user (a filter, rows removed): never stay on a page that is gone.
  const meta = data?.meta;
  useEffect(() => {
    if (meta === undefined || isPlaceholderData) return;
    const fixed = clampPage(params.page, meta.totalPages);
    if (fixed !== params.page)
      router.replace({ pathname, query: toQuery({ ...params, page: fixed }) });
  }, [meta, isPlaceholderData, params, pathname, router]);

  const day = (d: string) => formatDate(`${d}T00:00:00+07:00`, locale);
  const chips: AppliedFilter[] = [];
  const drop = (patch: Partial<ListParams>) => () => go({ ...params, ...patch, page: 1 }, false);
  if (params.status) {
    chips.push({
      key: 'status',
      label: t('filterStatus', { value: ts(params.status) }),
      onRemove: drop({ status: undefined }),
    });
  }
  if (params.type) {
    chips.push({
      key: 'type',
      label: t('filterType', { value: t(`types.${params.type}`) }),
      onRemove: drop({ type: undefined }),
    });
  }
  if (params.from) {
    chips.push({
      key: 'from',
      label: t('filterFrom', { value: day(params.from) }),
      onRemove: drop({ from: undefined }),
    });
  }
  if (params.to) {
    chips.push({
      key: 'to',
      label: t('filterTo', { value: day(params.to) }),
      onRemove: drop({ to: undefined }),
    });
  }

  const columns: Column<DocumentRow>[] = [
    {
      key: 'id',
      header: t('colId'),
      width: 140,
      cell: (d) => <code className="font-mono text-xs">{d.id.slice(0, 8)}</code>,
    },
    { key: 'type', header: t('colType'), width: 120, cell: (d) => t(`types.${d.sourceType}`) },
    {
      key: 'status',
      header: t('colStatus'),
      width: 200,
      cell: (d) => <StatusBadge status={d.status} label={ts(d.status)} />,
    },
    {
      key: 'createdAt',
      header: t('colCreated'),
      width: 240,
      sortable: true,
      cell: (d) => (
        <time dateTime={d.createdAt} className="whitespace-nowrap">
          {formatDate(d.createdAt, locale, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      ),
    },
  ];

  const emptyAction = (
    <Link href="/upload" className="text-sm underline">
      {t('goUpload')}
    </Link>
  );
  // Why the table has no rows, if it has none. It is shown inside the table's body, so the header,
  // the scrollbar and the footer stay where they are in every state.
  let state: ReactNode;
  if (error && !data) {
    state = (
      <StatePanel
        bare
        kind="error"
        title={t(`errors.${error.kind}.title`)}
        description={t(`errors.${error.kind}.hint`)}
        action={
          error.kind === 'session' ? (
            <Link href="/login" className="text-sm underline">
              {t('signIn')}
            </Link>
          ) : (
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                {t('retry')}
              </Button>
              {/* A page number that no longer works fails the same way every time: offer the way out. */}
              {params.page !== 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => go({ ...params, page: 1 }, false)}
                >
                  {t('first')}
                </Button>
              )}
            </div>
          )
        }
      />
    );
  } else if (data && data.items.length === 0 && data.meta.total === 0) {
    const filtered = hasFilters(params);
    state = (
      <StatePanel
        bare
        kind="empty"
        title={filtered ? t('emptyFiltered') : t('empty')}
        description={filtered ? undefined : t('emptyHint')}
        action={
          filtered ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => go(withoutFilters(params), false)}
            >
              {t('clear')}
            </Button>
          ) : (
            emptyAction
          )
        }
      />
    );
  }

  return (
    <PageLayout fill data-testid="documents-screen">
      <ListPageHeader
        title={t('title')}
        description={t('description')}
        count={data ? t('count', { count: data.meta.total }) : undefined}
        countLabel={data ? t('countAria', { count: data.meta.total }) : undefined}
        refreshing={isFetching && !isPending}
        refreshingLabel={t('refreshing')}
        actions={
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('refresh')}
            title={t('refresh')}
            data-testid="refresh"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw aria-hidden className={isFetching ? 'animate-spin' : undefined} />
          </Button>
        }
      />
      <Filters params={params} onChange={(next) => go(next, false)} />
      <AppliedFilters filters={chips} onClearAll={() => go(withoutFilters(params), false)} />
      {/* A failed refresh keeps the rows already shown; say so instead of hiding the problem. */}
      {error && data && (
        <p role="status" className="flex-none text-sm text-destructive">
          {t('staleHint')}
        </p>
      )}
      <DataGrid
        caption={t('caption')}
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(d) => d.id}
        rowAttrs={(d) => ({ 'data-testid': `document-row-${d.id}`, 'data-status': d.status })}
        sort={{ key: 'createdAt', direction: params.sort === 'createdAt' ? 'asc' : 'desc' }}
        onSort={() =>
          go(
            {
              ...params,
              sort: params.sort === 'createdAt' ? '-createdAt' : 'createdAt',
              page: 1,
            },
            false,
          )
        }
        sortLabel={(c) => tl('sortBy', { column: c.header })}
        // Also while the page is past the end (rows empty, total not): the effect above is about to move us.
        loading={
          isPending || (data !== undefined && data.items.length === 0 && data.meta.total > 0)
        }
        state={state}
        busy={isFetching}
        dimmed={isPlaceholderData}
        footer={
          <ListPagination
            page={data?.meta.page ?? params.page}
            pageSize={data?.meta.limit ?? params.pageSize}
            pageSizes={PAGE_SIZES}
            total={data?.meta.total ?? 0}
            totalPages={data?.meta.totalPages ?? 0}
            onPageChange={(page) => go({ ...params, page }, true)}
            onPageSizeChange={(n) =>
              go(
                {
                  ...params,
                  page: 1,
                  pageSize: PAGE_SIZES.find((p) => p === n) ?? (DEFAULT_PAGE_SIZE as PageSize),
                },
                false,
              )
            }
          />
        }
      />
    </PageLayout>
  );
}
