'use client';

import type { QaAggregateResult } from 'contracts';
import { useLocale, useTranslations } from 'next-intl';
import { formatDate, formatMoney, formatNumber } from '@/i18n/format';

const dateOf = (iso: string, locale: string) => formatDate(iso, locale, { dateStyle: 'medium' });

/**
 * The answer to an aggregate question. The numbers come from SQL, not from the model (T5.4): the
 * web writes the sentence from a translated template and formats money per currency for the locale.
 * The filter the model chose is shown, so a misread question ("September" of which year? which
 * supplier?) is visible next to the number it produced.
 */
export function AggregateView({ result }: Readonly<{ result: QaAggregateResult }>) {
  const t = useTranslations('Qa.aggregate');
  const locale = useLocale();
  const { filter } = result;
  const count = filter.metric === 'invoiceCount';

  const conditions: string[] = [];
  if (filter.sellerName !== null) conditions.push(t('filter.seller', { name: filter.sellerName }));
  if (filter.sellerTaxCode !== null) {
    conditions.push(t('filter.taxCode', { code: filter.sellerTaxCode }));
  }
  if (filter.issueDateFrom !== null && filter.issueDateTo !== null) {
    conditions.push(
      t('filter.between', {
        from: dateOf(filter.issueDateFrom, locale),
        to: dateOf(filter.issueDateTo, locale),
      }),
    );
  } else if (filter.issueDateFrom !== null) {
    conditions.push(t('filter.from', { from: dateOf(filter.issueDateFrom, locale) }));
  } else if (filter.issueDateTo !== null) {
    conditions.push(t('filter.to', { to: dateOf(filter.issueDateTo, locale) }));
  }
  if (filter.itemDescription !== null) {
    conditions.push(t('filter.item', { item: filter.itemDescription }));
  }
  if (filter.currency !== null)
    conditions.push(t('filter.currency', { currency: filter.currency }));

  const shownSellers = result.sellers.map((s) => s.name).join(', ');
  const hiddenSellers = result.sellerCount - result.sellers.length;

  return (
    <div className="flex flex-col gap-3" data-testid="qa-aggregate" data-metric={filter.metric}>
      <p className="text-sm text-muted-foreground">{t(`metric.${filter.metric}`)}</p>
      <ul className="flex flex-col gap-1">
        {count ? (
          <li className="text-2xl font-semibold tabular-nums" data-testid="qa-aggregate-value">
            {formatNumber(result.invoiceCount, locale)}
          </li>
        ) : (
          result.results.map((r) => (
            <li
              key={r.currency}
              className="text-2xl font-semibold tabular-nums"
              data-testid="qa-aggregate-value"
            >
              {formatMoney(r.amount, r.currency, locale)}
            </li>
          ))
        )}
      </ul>
      {!count && result.results.length > 1 && (
        <p className="text-sm text-muted-foreground">{t('perCurrency')}</p>
      )}
      <p className="text-sm">{t('invoices', { count: result.invoiceCount })}</p>
      <p className="text-sm" data-testid="qa-aggregate-filter">
        {conditions.length > 0
          ? t('filter.applied', { conditions: conditions.join(' · ') })
          : t('filter.none')}
      </p>
      {result.sellerCount > 1 && (
        <p className="text-sm text-warning-soft-foreground" data-testid="qa-aggregate-sellers">
          {t('sellers', { count: result.sellerCount, names: shownSellers })}
          {hiddenSellers > 0 && ` ${t('moreSellers', { count: hiddenSellers })}`}
        </p>
      )}
    </div>
  );
}
