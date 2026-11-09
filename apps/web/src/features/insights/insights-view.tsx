import type { ExtractionInsights, OfflineInsights, OnlineInsights } from 'contracts';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { PageLayout } from '@/components/common/page-layout';
import { StatePanel } from '@/components/common/state-panel';
import { formatDate, formatNumber, formatPercent, formatUsdEstimate } from '@/i18n/format';
import { BarList } from './bar-list';
import { fieldKey } from './field-label';
import type { InsightsLoad } from './load-insights';

type T = ReturnType<typeof useTranslations<'Insights'>>;

/** The translated name of a field path; an unknown path is shown as it is rather than hidden. */
const labelOf = (t: T, path: string): string => {
  const key = `field.${fieldKey(path)}` as Parameters<T>[0];
  return t.has(key) ? t(key) : path;
};

function Section({
  title,
  description,
  children,
  testId,
}: Readonly<{ title: string; description?: string; children: ReactNode; testId: string }>) {
  return (
    <section data-testid={testId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, note }: Readonly<{ label: string; value: string; note?: string }>) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono text-2xl font-semibold tabular-nums">{value}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

function Kpis({
  online,
  offline,
}: Readonly<{ online: OnlineInsights; offline: OfflineInsights | null }>) {
  const t = useTranslations('Insights');
  const locale = useLocale();
  const n = online.approvedDocuments;
  return (
    <dl aria-label={t('kpi.label')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi label={t('kpi.approved')} value={formatNumber(n, locale)} />
      <Kpi
        label={t('kpi.uncorrected')}
        value={n === 0 ? '–' : formatPercent(online.uncorrectedDocuments / n, locale)}
      />
      <Kpi
        label={t('kpi.costOnline')}
        value={
          online.costUsdPerDocument === null
            ? t('kpi.costNone')
            : formatUsdEstimate(online.costUsdPerDocument, locale)
        }
        note={t('kpi.costNote')}
      />
      <Kpi
        label={t('kpi.costOffline')}
        value={
          offline === null
            ? t('kpi.costNone')
            : formatUsdEstimate(offline.costUsdPerDocument, locale)
        }
        note={t('kpi.costNote')}
      />
    </dl>
  );
}

function Online({ online }: Readonly<{ online: OnlineInsights }>) {
  const t = useTranslations('Insights');
  const locale = useLocale();
  const total = online.approvedDocuments;
  return (
    <Section
      testId="insights-online"
      title={t('online.title')}
      description={t('online.description')}
    >
      {total === 0 ? (
        <StatePanel
          kind="empty"
          bare
          title={t('online.emptyTitle')}
          description={t('online.emptyHint')}
        />
      ) : (
        <BarList
          label={t('online.chartLabel')}
          tone="warning"
          bars={online.fields.map((f) => ({
            key: f.field,
            label: labelOf(t, f.field),
            ratio: f.rate,
            value: t('online.value', {
              rate: formatPercent(f.rate, locale),
              documents: formatNumber(f.documents, locale),
              total: formatNumber(total, locale),
            }),
          }))}
        />
      )}
      <p className="text-sm text-muted-foreground">
        {t('online.xmlExcluded', { count: online.excludedXmlDocuments })}
      </p>
    </Section>
  );
}

function Offline({ offline }: Readonly<{ offline: OfflineInsights | null }>) {
  const t = useTranslations('Insights');
  const locale = useLocale();
  if (offline === null) {
    return (
      <Section testId="insights-offline" title={t('offline.title')}>
        <StatePanel
          kind="empty"
          bare
          title={t('offline.missingTitle')}
          description={t('offline.missingHint')}
        />
      </Section>
    );
  }
  // Milliseconds to seconds with one decimal (4623 -> 4.6).
  const seconds = (ms: number) => formatNumber(Math.round(ms / 100) / 10, locale);
  const summary: [string, string][] = [
    [t('offline.criticalExact'), formatPercent(offline.criticalExact, locale)],
    [t('offline.documentExact'), formatPercent(offline.documentExact, locale)],
    [t('offline.linesF1'), formatPercent(offline.linesF1, locale)],
    [
      t('offline.latency'),
      t('offline.latencyValue', {
        p50: seconds(offline.latency.p50Ms),
        p95: seconds(offline.latency.p95Ms),
      }),
    ],
  ];
  return (
    <Section
      testId="insights-offline"
      title={t('offline.title')}
      description={t('offline.description', {
        model: offline.model,
        prompt: offline.promptVersion,
        dataset: offline.dataset,
        documents: formatNumber(offline.documents, locale),
        dates: offline.runDates.map((d) => formatDate(d, locale)).join(', '),
      })}
    >
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {summary.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <BarList
        label={t('offline.chartLabel')}
        bars={offline.fields.map((f) => ({
          key: f.field,
          label: labelOf(t, f.field),
          ratio: f.accuracy,
          value: formatPercent(f.accuracy, locale),
        }))}
      />
    </Section>
  );
}

function Limits() {
  const t = useTranslations('Insights');
  return (
    <Section testId="insights-limits" title={t('limits.title')}>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{t('limits.synthetic')}</li>
        <li>{t('limits.positional')}</li>
        <li>{t('limits.cost')}</li>
        <li>{t('limits.latency')}</li>
      </ul>
    </Section>
  );
}

/** /insights: online correction rate next to offline eval accuracy (T4.6). No state, no fetching. */
export function InsightsView({ load }: Readonly<{ load: InsightsLoad }>) {
  const t = useTranslations('Insights');
  return (
    <PageLayout data-testid="insights-page">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      {load.kind === 'error' ? (
        <StatePanel
          kind="error"
          title={t(`error.${load.error}.title`)}
          description={t(`error.${load.error}.hint`)}
        />
      ) : (
        <Body data={load.data} />
      )}
    </PageLayout>
  );
}

function Body({ data }: Readonly<{ data: ExtractionInsights }>) {
  return (
    <>
      <Kpis online={data.online} offline={data.offline} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Online online={data.online} />
        <Offline offline={data.offline} />
      </div>
      <Limits />
    </>
  );
}
