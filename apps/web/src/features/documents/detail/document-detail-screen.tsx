'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { PageLayout } from '@/components/common/page-layout';
import { StatePanel } from '@/components/common/state-panel';
import { StatusBadge } from '@/components/common/status-badge';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney, formatNumber } from '@/i18n/format';
import { Link } from '@/i18n/navigation';
import { QueryProvider } from '../query-provider';
import type { DocumentDetail } from './detail-client';
import { useDocumentDetail } from './use-document-detail';

export function DocumentDetailScreen({ id }: Readonly<{ id: string }>) {
  return (
    <QueryProvider>
      <Detail id={id} />
    </QueryProvider>
  );
}

type Invoice = NonNullable<DocumentDetail['extraction']>['data'];

/** formatMoney knows VND and USD only; any other ISO code is shown as a plain number plus the code. */
function useMoney(currency: string) {
  const locale = useLocale();
  return (minor: number) =>
    currency === 'VND' || currency === 'USD'
      ? formatMoney(minor, currency, locale)
      : `${formatNumber(minor, locale)} ${currency}`;
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function Card({
  title,
  children,
  ...rest
}: Readonly<{ title: string; children: ReactNode; 'data-testid'?: string }>) {
  return (
    <section {...rest} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function InvoiceView({ invoice }: Readonly<{ invoice: Invoice }>) {
  const t = useTranslations('DocumentDetail');
  const locale = useLocale();
  const money = useMoney(invoice.currency);
  const none = t('none');

  return (
    <div className="flex flex-col gap-4" data-testid="invoice-data">
      <Card title={t('invoiceInfo')}>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label={t('invoiceNo')}>{invoice.invoiceNo}</Field>
          <Field label={t('series')}>{invoice.series}</Field>
          <Field label={t('issueDate')}>
            {formatDate(`${invoice.issueDate}T00:00:00+07:00`, locale)}
          </Field>
          <Field label={t('currency')}>{invoice.currency}</Field>
        </dl>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('seller')} data-testid="seller">
          <dl className="flex flex-col gap-3">
            <Field label={t('name')}>{invoice.seller.name}</Field>
            <Field label={t('taxCode')}>{invoice.seller.taxCode}</Field>
            <Field label={t('address')}>{invoice.seller.address}</Field>
          </dl>
        </Card>
        <Card title={t('buyer')} data-testid="buyer">
          <dl className="flex flex-col gap-3">
            <Field label={t('name')}>{invoice.buyer.name}</Field>
            <Field label={t('taxCode')}>{invoice.buyer.taxCode ?? none}</Field>
            <Field label={t('address')}>{invoice.buyer.address}</Field>
          </dl>
        </Card>
      </div>
      <Card title={t('lines')}>
        <Table data-testid="invoice-lines">
          <TableCaption className="sr-only">{t('linesCaption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('description')}</TableHead>
              <TableHead className="text-right">{t('quantity')}</TableHead>
              <TableHead>{t('unit')}</TableHead>
              <TableHead className="text-right">{t('unitPrice')}</TableHead>
              <TableHead className="text-right">{t('vatRate')}</TableHead>
              <TableHead className="text-right">{t('amount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.lines.map((line, i) => (
              <TableRow key={`${i}-${line.description}`}>
                <TableCell className="whitespace-normal">{line.description}</TableCell>
                <TableCell className="text-right">{formatNumber(line.quantity, locale)}</TableCell>
                <TableCell>{line.unit}</TableCell>
                <TableCell className="text-right">{money(line.unitPrice)}</TableCell>
                <TableCell className="text-right">{formatNumber(line.vatRate, locale)}%</TableCell>
                <TableCell className="text-right">{money(line.amount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('vatBreakdown')}>
          {invoice.vatBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{none}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('vatRate')}</TableHead>
                  <TableHead className="text-right">{t('vatBase')}</TableHead>
                  <TableHead className="text-right">{t('vatAmount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.vatBreakdown.map((v, i) => (
                  <TableRow key={`${i}-${v.rate}`}>
                    <TableCell>{formatNumber(v.rate, locale)}%</TableCell>
                    <TableCell className="text-right">{money(v.base)}</TableCell>
                    <TableCell className="text-right">{money(v.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        <Card title={t('totals')}>
          <dl className="flex flex-col gap-3">
            <Field label={t('subtotal')}>{money(invoice.subtotal)}</Field>
            <Field label={t('total')}>
              <strong data-testid="invoice-total">{money(invoice.total)}</strong>
            </Field>
          </dl>
        </Card>
      </div>
    </div>
  );
}

/** Codes with a translated message (`DocumentDetail.failure.<code>`); any other code gets the generic one. */
export const FAILURE_CODES = [
  'EXTRACTION_RETRIES_EXHAUSTED',
  'EXTRACTION_STALLED',
  'EXTRACTION_FAILED',
  'EXTRACTION_SCHEMA_INVALID',
  'EXTRACTION_PATH_NOT_IMPLEMENTED',
  'AI_SERVICE_MISCONFIGURED',
  'LLM_UNAVAILABLE',
  'LLM_RATE_LIMITED',
  'LLM_TIMEOUT_OR_NETWORK',
  'LLM_BAD_RESPONSE',
  'LLM_MISCONFIGURED',
  'LLM_NOT_CONFIGURED',
  'LLM_REQUEST_REJECTED',
  'LLM_NO_CANDIDATE',
  'PDF_INVALID',
  'PDF_TOO_MANY_PAGES',
  'PDF_TOO_LARGE',
  'IMAGE_UNSUPPORTED',
  'FILE_MISSING',
  'FILE_TOO_LARGE',
  'XML_MALFORMED',
  'XML_FORBIDDEN_CONSTRUCT',
  'XML_TOO_COMPLEX',
  'XML_UNSUPPORTED_STRUCTURE',
  'XML_MISSING_FIELD',
  'XML_INVALID_VALUE',
  'XML_UNSUPPORTED_CURRENCY',
  'XML_UNSUPPORTED_VAT_RATE',
] as const;
type FailureCode = (typeof FAILURE_CODES)[number];
const isFailureCode = (code: string | null): code is FailureCode =>
  code !== null && (FAILURE_CODES as readonly string[]).includes(code);

function FailureReason({ code }: Readonly<{ code: string | null }>) {
  const t = useTranslations('DocumentDetail');
  return (
    <StatePanel
      kind="error"
      title={t('failedTitle')}
      description={isFailureCode(code) ? t(`failure.${code}`) : t('failure.unknown')}
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

function Detail({ id }: Readonly<{ id: string }>) {
  const t = useTranslations('DocumentDetail');
  const ts = useTranslations('Status');
  const tt = useTranslations('Documents');
  const locale = useLocale();
  const { data, error, isPending, refetch } = useDocumentDetail(id);

  let body: ReactNode;
  if (error && !data) {
    body = (
      <StatePanel
        kind="error"
        title={t(`errors.${error.kind}.title`)}
        description={t(`errors.${error.kind}.hint`)}
        action={
          error.kind === 'session' ? (
            <Link href="/login" className="text-sm underline">
              {t('signIn')}
            </Link>
          ) : error.kind === 'notFound' || error.kind === 'forbidden' ? null : (
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              {t('retry')}
            </Button>
          )
        }
      />
    );
  } else if (isPending || data === undefined) {
    body = <StatePanel kind="loading" title={t('loading')} />;
  } else if (data.extraction !== null) {
    body = <InvoiceView invoice={data.extraction.data} />;
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
    <PageLayout data-testid="document-detail">
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
        {error && data && (
          <p role="status" className="text-sm text-destructive">
            {t('staleHint')}
          </p>
        )}
      </header>
      {body}
    </PageLayout>
  );
}
