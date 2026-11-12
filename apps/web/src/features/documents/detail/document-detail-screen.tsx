'use client';

import { isDocumentFailureCode } from 'contracts';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { PageLayout } from '@/components/common/page-layout';
import { StatePanel } from '@/components/common/state-panel';
import { StatusBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/i18n/format';
import { Link } from '@/i18n/navigation';
import { ReviewScreen } from '@/features/review/review-screen';
import { QueryProvider } from '../query-provider';
import type { DetailError } from './detail-client';
import { useDocumentDetail } from './use-document-detail';

export function DocumentDetailScreen({
  id,
  canApprove,
  citedFields,
}: Readonly<{ id: string; canApprove: boolean; citedFields?: readonly string[] }>) {
  return (
    <QueryProvider>
      <Detail id={id} canApprove={canApprove} citedFields={citedFields} />
    </QueryProvider>
  );
}

function FailureReason({ code }: Readonly<{ code: string | null }>) {
  const t = useTranslations('DocumentDetail');
  return (
    <StatePanel
      kind="error"
      title={t('failedTitle')}
      description={isDocumentFailureCode(code) ? t(`failure.${code}`) : t('failure.unknown')}
      action={
        code !== null && (
          <code data-testid="failure-code" className="font-mono text-xs">
            {code}
          </code>
        )
      }
    />
  );
}

/** What to offer under a load error: sign in again, nothing (it can never work), or retry. */
function ErrorAction({ kind, retry }: Readonly<{ kind: DetailError['kind']; retry: () => void }>) {
  const t = useTranslations('DocumentDetail');
  if (kind === 'session') {
    return (
      <Link href="/login" className="text-sm underline">
        {t('signIn')}
      </Link>
    );
  }
  if (kind === 'notFound' || kind === 'forbidden') return null;
  return (
    <Button type="button" variant="outline" size="sm" onClick={retry}>
      {t('retry')}
    </Button>
  );
}

function Detail({
  id,
  canApprove,
  citedFields,
}: Readonly<{ id: string; canApprove: boolean; citedFields?: readonly string[] }>) {
  const t = useTranslations('DocumentDetail');
  const ts = useTranslations('Status');
  const tt = useTranslations('Documents');
  const locale = useLocale();
  const { data, error, isPending, refetch } = useDocumentDetail(id);

  const reviewing = data?.extraction != null; // the split view takes the height the shell has left
  let body: ReactNode;
  if (error && !data) {
    body = (
      <StatePanel
        kind="error"
        title={t(`errors.${error.kind}.title`)}
        description={t(`errors.${error.kind}.hint`)}
        action={<ErrorAction kind={error.kind} retry={() => void refetch()} />}
      />
    );
  } else if (isPending || data === undefined) {
    body = <StatePanel kind="loading" title={t('loading')} />;
  } else if (data.extraction !== null) {
    body = (
      <>
        {data.status === 'failed' && <FailureReason code={data.failureCode} />}
        <ReviewScreen
          document={data}
          extraction={data.extraction}
          canApprove={canApprove}
          onChanged={() => refetch()}
          citedFields={citedFields}
        />
      </>
    );
  } else if (data.status === 'failed') {
    body = <FailureReason code={data.failureCode} />;
  } else if (
    data.status === 'uploaded' ||
    data.status === 'queued' ||
    data.status === 'processing'
  ) {
    body = (
      <StatePanel
        kind="loading"
        title={t(`waiting.${data.status}.title`)}
        description={t('waiting.hint')}
      />
    );
  } else {
    body = (
      <StatePanel kind="empty" title={t('noExtraction')} description={t('noExtractionHint')} />
    );
  }

  return (
    <PageLayout fill={reviewing} data-testid="document-detail">
      <Link href="/documents" className="text-sm underline">
        {t('back')}
      </Link>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          {data && <StatusBadge status={data.status} label={ts(data.status)} />}
        </div>
        {data && (
          <p className="text-sm text-muted-foreground">
            <code className="font-mono text-xs" data-testid="document-id">
              {data.id.slice(0, 8)}
            </code>
            {' · '}
            {tt(`types.${data.sourceType}`)}
            {' · '}
            {t('version', { version: data.version })}
            {' · '}
            <time dateTime={data.createdAt}>
              {formatDate(data.createdAt, locale, { dateStyle: 'medium', timeStyle: 'short' })}
            </time>
          </p>
        )}
        {error && data && <output className="text-sm text-destructive">{t('staleHint')}</output>}
      </header>
      {body}
    </PageLayout>
  );
}
