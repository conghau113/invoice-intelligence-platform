import { cookies } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { DataTable, type Column } from '@/components/common/data-table';
import { FormField } from '@/components/common/form-field';
import { LanguageSwitcher } from '@/components/common/language-switcher';
import { StatePanel } from '@/components/common/state-panel';
import { DOCUMENT_STATUSES, StatusBadge } from '@/components/common/status-badge';
import { ThemeToggle } from '@/components/common/theme-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate, formatMoney } from '@/i18n/format';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import { SAMPLE_INVOICES, SAMPLE_TAX_CODE, type SampleInvoice } from './sample-data';
import { SPACING_STEPS, SWATCHES } from './swatches';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export async function Styleguide() {
  const t = await getTranslations('Styleguide');
  const ts = await getTranslations('Status');
  const locale = await getLocale();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  const columns: Column<SampleInvoice>[] = [
    {
      key: 'number',
      header: t('colNumber'),
      cell: (r) => <span className="font-mono">{r.number}</span>,
    },
    { key: 'seller', header: t('colSeller'), cell: (r) => r.seller },
    { key: 'date', header: t('colDate'), cell: (r) => formatDate(r.issuedAt, locale) },
    {
      key: 'total',
      header: t('colTotal'),
      numeric: true,
      cell: (r) => formatMoney(r.totalVnd, 'VND', locale),
    },
    {
      key: 'status',
      header: t('colStatus'),
      cell: (r) => <StatusBadge status={r.status} label={ts(r.status)} />,
    },
  ];

  return (
    <>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t('skipToContent')}
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-(--content-max) items-center justify-between gap-4 px-4 py-3">
          <p className="font-semibold">{t('title')}</p>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle initial={theme} />
          </div>
        </div>
      </header>
      <main id="content" className="mx-auto flex max-w-(--content-max) flex-col gap-8 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('intro')}</p>
        </div>

        <Section id="colors" title={t('colorsTitle')}>
          <p className="text-sm text-muted-foreground">{t('colorsHint')}</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {SWATCHES.map(([bg, fg]) => (
              <li
                key={bg}
                className="rounded-lg border p-3 font-mono text-xs"
                style={{ backgroundColor: `var(--${bg})`, color: `var(--${fg})` }}
              >
                {bg}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="typography" title={t('typographyTitle')}>
          <p className="text-3xl font-semibold">{t('headingSample')}</p>
          <p>{t('bodySample')}</p>
          <p className="font-mono">{t('monoSample')}</p>
        </Section>

        <Section id="spacing" title={t('spacingTitle')}>
          <ul className="flex flex-wrap items-end gap-3">
            {SPACING_STEPS.map((n) => (
              <li
                key={n}
                className="flex flex-col items-center gap-1 text-xs text-muted-foreground"
              >
                <span
                  className="block bg-primary"
                  style={{ width: `calc(var(--spacing) * ${n})`, height: '1.5rem' }}
                />
                {n * 4}
              </li>
            ))}
          </ul>
        </Section>

        <Section id="buttons" title={t('buttonsTitle')}>
          <div className="flex flex-wrap gap-2">
            <Button>{t('primary')}</Button>
            <Button variant="secondary">{t('secondary')}</Button>
            <Button variant="outline">{t('outline')}</Button>
            <Button variant="ghost">{t('ghost')}</Button>
            <Button variant="destructive">{t('destructive')}</Button>
            <Button disabled>{t('disabled')}</Button>
          </div>
        </Section>

        <Section id="badges" title={t('badgesTitle')}>
          <ul className="flex flex-wrap gap-2">
            {DOCUMENT_STATUSES.map((s) => (
              <li key={s}>
                <StatusBadge status={s} label={ts(s)} />
              </li>
            ))}
          </ul>
        </Section>

        <Section id="table" title={t('tableTitle')}>
          <DataTable
            caption={t('tableCaption')}
            columns={columns}
            rows={SAMPLE_INVOICES}
            rowKey={(r) => r.id}
          />
        </Section>

        <Section id="form" title={t('formTitle')}>
          <form className="grid max-w-xl gap-4" noValidate>
            <FormField label={t('fieldSeller')} hint={t('fieldSellerHint')} required>
              {(c) => <Input {...c} defaultValue="SAMPLE Công ty A" autoComplete="off" />}
            </FormField>
            <FormField label={t('fieldTaxCode')} error={t('fieldTaxCodeError')} required>
              {(c) => (
                <Input
                  {...c}
                  defaultValue={SAMPLE_TAX_CODE}
                  inputMode="numeric"
                  className="font-mono"
                />
              )}
            </FormField>
            <FormField label={t('fieldTotal')} hint={t('fieldTotalWarning')}>
              {(c) => (
                <Input
                  {...c}
                  defaultValue={formatMoney(24850000, 'VND', locale)}
                  className="border-warning bg-warning-soft text-warning-soft-foreground"
                />
              )}
            </FormField>
          </form>
        </Section>

        <Section id="states" title={t('statesTitle')}>
          <div className="grid gap-3 md:grid-cols-3">
            <StatePanel kind="loading" title={t('loading')} />
            <StatePanel kind="empty" title={t('emptyTitle')} description={t('emptyHint')} />
            <StatePanel
              kind="error"
              title={t('errorTitle')}
              description={t('errorHint')}
              action={<Button variant="outline">{t('retry')}</Button>}
            />
          </div>
        </Section>

        <Section id="a11y" title={t('a11yTitle')}>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {(['a11y1', 'a11y2', 'a11y3', 'a11y4', 'a11y5'] as const).map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        </Section>
      </main>
    </>
  );
}
