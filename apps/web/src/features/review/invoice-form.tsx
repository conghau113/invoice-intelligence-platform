'use client';

import { todayInVietnam, type Invoice, type RuleWarning } from 'contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  Controller,
  FormProvider,
  get,
  useFieldArray,
  useForm,
  useFormContext,
  useWatch,
  type Path,
} from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FieldShell } from './field-shell';
import {
  invoiceResolver,
  liveWarnings,
  sumOfLines,
  toFormValues,
  type FormValues,
} from './form-values';
import { formatDecimal, formatMinor, minorDigits, parseDecimal, parseMinor } from './numeric';
import { NumericInput } from './numeric-input';
import { ReviewProvider, useReview } from './review-context';
import type { ViewerEvidence } from './viewer/types';
import { useMoney } from './use-money';
import { shiftLineMeta, weakFields, type WeakReason } from './weak-fields';

const EMPTY_LINE: FormValues['lines'][number] = {
  description: '',
  quantity: 1,
  unit: '',
  unitPrice: 0,
  vatRate: 0,
  amount: 0,
};

function Card({
  title,
  children,
  ...rest
}: Readonly<{ title: string; children: React.ReactNode; 'data-testid'?: string }>) {
  return (
    <section {...rest} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function useFieldError(name: string): string | undefined {
  const {
    formState: { errors },
  } = useFormContext<FormValues>();
  const { errorText } = useReview();
  const err = get(errors, name) as { type?: string } | undefined;
  return err ? errorText(err.type) : undefined;
}

function TextField({
  name,
  label,
  hint,
  hideLabel,
  type = 'text',
  className,
}: Readonly<{
  name: Path<FormValues>;
  label: string;
  hint?: string;
  hideLabel?: boolean;
  type?: 'text' | 'date';
  className?: string;
}>) {
  const { register } = useFormContext<FormValues>();
  const error = useFieldError(name);
  return (
    <FieldShell
      path={name}
      label={label}
      hint={hint}
      hideLabel={hideLabel}
      error={error}
      className={className}
    >
      {({ readOnly, ...control }) => (
        <Input
          type={type}
          readOnly={readOnly}
          data-testid={`field-${name}`}
          {...control}
          {...register(name)}
        />
      )}
    </FieldShell>
  );
}

function NumberField({
  name,
  label,
  money,
  hint,
  hideLabel,
}: Readonly<{
  name: Path<FormValues>;
  label: string;
  /** Minor units of the invoice currency, shown in major units; otherwise a plain decimal. */
  money: boolean;
  hint?: string;
  hideLabel?: boolean;
}>) {
  const { control } = useFormContext<FormValues>();
  const { fractionDigits } = useReview();
  const error = useFieldError(name);
  const parse = useCallback(
    (text: string) => (money ? parseMinor(text, fractionDigits) : parseDecimal(text)),
    [money, fractionDigits],
  );
  const format = useCallback(
    (n: number) => (money ? formatMinor(n, fractionDigits) : formatDecimal(n)),
    [money, fractionDigits],
  );
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <FieldShell path={name} label={label} hint={hint} hideLabel={hideLabel} error={error}>
          {({ readOnly, ...c }) => (
            <NumericInput
              key={money ? fractionDigits : 'plain'} // new digits: re-read the text from the value
              {...c}
              readOnly={readOnly}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={field.value as number}
              onChange={field.onChange}
              parse={parse}
              format={format}
              className="text-right"
              data-testid={`field-${name}`}
            />
          )}
        </FieldShell>
      )}
    />
  );
}

/** Label of a field path for the warning list: "Line 2 · Amount". */
function usePathLabel() {
  const t = useTranslations('DocumentDetail');
  const tr = useTranslations('Review');
  return (path: string): string => {
    const [a, b, c] = path.split('.');
    const FIELD = {
      description: t('description'),
      quantity: t('quantity'),
      unit: t('unit'),
      unitPrice: t('unitPrice'),
      vatRate: t('vatRate'),
      amount: t('amount'),
      rate: t('vatRate'),
      base: t('vatBase'),
      name: t('name'),
      taxCode: t('taxCode'),
      address: t('address'),
    } as Record<string, string>;
    if (a === 'lines') return `${tr('lineN', { n: Number(b) + 1 })} · ${FIELD[c ?? ''] ?? c}`;
    if (a === 'vatBreakdown') {
      const field = c === 'amount' ? t('vatAmount') : (FIELD[c ?? ''] ?? c);
      return `${t('vatBreakdown')} ${Number(b) + 1} · ${field}`;
    }
    if (a === 'seller' || a === 'buyer') return `${t(a)} · ${FIELD[b ?? ''] ?? b}`;
    const TOP = {
      invoiceNo: t('invoiceNo'),
      series: t('series'),
      issueDate: t('issueDate'),
      currency: t('currency'),
      subtotal: t('subtotal'),
      total: t('total'),
    } as Record<string, string>;
    return TOP[a ?? ''] ?? path;
  };
}

function Lines({ canEdit }: Readonly<{ canEdit: boolean }>) {
  const t = useTranslations('DocumentDetail');
  const tr = useTranslations('Review');
  const { control, getValues, setValue } = useFormContext<FormValues>();
  const { weak, reasonText } = useReview();
  const pathLabel = usePathLabel();
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });

  /**
   * Why this line's cells are yellow, as visible text (a tooltip does not open on touch). Rule
   * warnings are left out: the warnings box above already lists them. Cells with no AI
   * confidence are grouped into one sentence, or a new line would repeat it six times.
   */
  const notesFor = (i: number): string[] => {
    const notes: string[] = [];
    const unknown: string[] = [];
    for (const [path, reasons] of weak) {
      if (!path.startsWith(`lines.${i}.`)) continue;
      const column = pathLabel(path).split(' · ').at(-1) ?? path;
      for (const r of reasons) {
        if (r.kind === 'noMeta') unknown.push(column);
        else if (r.kind === 'lowConfidence') notes.push(`${column}: ${reasonText(r)}`);
      }
    }
    if (unknown.length > 0) notes.push(tr('reason.noMetaMany', { fields: unknown.join(', ') }));
    return notes;
  };
  const lastLine = fields.length <= 1;

  return (
    <Card title={t('lines')}>
      <div className="overflow-x-auto">
        <Table data-testid="invoice-lines" className="min-w-[44rem]">
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-48">{t('description')}</TableHead>
              <TableHead className="w-20 text-right">{t('quantity')}</TableHead>
              <TableHead className="w-24">{t('unit')}</TableHead>
              <TableHead className="w-32 text-right">{t('unitPrice')}</TableHead>
              <TableHead className="w-20 text-right">{t('vatRate')}</TableHead>
              <TableHead className="w-32 text-right">{t('amount')}</TableHead>
              {canEdit && (
                <TableHead className="w-10">
                  <span className="sr-only">{tr('removeColumn')}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((row, i) => {
              const n = tr('lineN', { n: i + 1 });
              const notes = notesFor(i);
              return (
                <Fragment key={row.id}>
                  <TableRow data-testid={`line-${i}`}>
                    <TableCell className="align-top whitespace-normal">
                      <TextField
                        name={`lines.${i}.description`}
                        label={`${n} · ${t('description')}`}
                        hideLabel
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <NumberField
                        name={`lines.${i}.quantity`}
                        label={`${n} · ${t('quantity')}`}
                        money={false}
                        hideLabel
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <TextField name={`lines.${i}.unit`} label={`${n} · ${t('unit')}`} hideLabel />
                    </TableCell>
                    <TableCell className="align-top">
                      <NumberField
                        name={`lines.${i}.unitPrice`}
                        label={`${n} · ${t('unitPrice')}`}
                        money
                        hideLabel
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <NumberField
                        name={`lines.${i}.vatRate`}
                        label={`${n} · ${t('vatRate')}`}
                        money={false}
                        hideLabel
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <NumberField
                        name={`lines.${i}.amount`}
                        label={`${n} · ${t('amount')}`}
                        money
                        hideLabel
                      />
                    </TableCell>
                    {canEdit && (
                      <TableCell className="align-top">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={lastLine}
                          aria-label={tr('removeLine', { n: i + 1 })}
                          onClick={() => {
                            remove(i);
                            // Meta is keyed by line index: later lines move up, so must their meta.
                            setValue('fieldMeta', shiftLineMeta(getValues('fieldMeta'), i));
                          }}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                  {notes.length > 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={canEdit ? 7 : 6}
                        data-testid={`line-notes-${i}`}
                        className="py-1 text-xs whitespace-normal text-warning"
                      >
                        {notes.join(' ')}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {canEdit && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="add-line"
            onClick={() => append({ ...EMPTY_LINE })}
          >
            <Plus aria-hidden /> {tr('addLine')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function VatRows() {
  const t = useTranslations('DocumentDetail');
  const { control } = useFormContext<FormValues>();
  const { fields } = useFieldArray({ control, name: 'vatBreakdown' });
  return (
    <Card title={t('vatBreakdown')}>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {fields.map((row, i) => (
            <div key={row.id} className="grid grid-cols-3 gap-3" data-testid={`vat-${i}`}>
              <NumberField name={`vatBreakdown.${i}.rate`} label={t('vatRate')} money={false} />
              <NumberField name={`vatBreakdown.${i}.base`} label={t('vatBase')} money />
              <NumberField name={`vatBreakdown.${i}.amount`} label={t('vatAmount')} money />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export interface InvoiceFormProps {
  extraction: { data: Invoice; warnings: RuleWarning[] };
  /** Whether the person may change values. A viewer sees the same form, read-only. */
  canEdit: boolean;
  /** The reviewer focused a field: the viewer shows its evidence (a new object each time). */
  onEvidence: (evidence: ViewerEvidence | null) => void;
  /** Called with the validated Invoice when the person approves; never with schema errors. */
  onValid: (invoice: Invoice) => void;
  /** An approval is on its way: the button waits. */
  submitting: boolean;
  /** Why the last approval did not happen, already translated. */
  submitError: string | null;
  /** Says why the form is read-only when it is not about permissions. */
  readOnlyText?: string;
}

export function InvoiceForm({
  extraction,
  canEdit,
  onEvidence,
  onValid,
  submitting,
  submitError,
  readOnlyText,
}: Readonly<InvoiceFormProps>) {
  const t = useTranslations('Review');
  const td = useTranslations('DocumentDetail');
  const pathLabel = usePathLabel();

  // Read once on mount: a refetch must never overwrite what the reviewer typed. The parent
  // remounts this component (new `key`) only when the person asks to load a newer extraction.
  const methods = useForm<FormValues, unknown, Invoice>({
    defaultValues: toFormValues(extraction.data),
    resolver: invoiceResolver,
    mode: 'onChange',
  });
  const { control, handleSubmit, getValues } = methods;

  const values = useWatch({ control }) as FormValues;
  // The rules run on a deferred copy, so typing stays responsive on a long invoice.
  const deferred = useDeferredValue(values);
  const [today] = useState(() => todayInVietnam(new Date()));
  // null = the values do not pass the schema yet (half-typed): keep the last warnings, the field
  // errors explain what is wrong. The rules are defined on a valid Invoice only.
  const live = useMemo(() => liveWarnings(deferred, today), [deferred, today]);
  const [kept, setKept] = useState(extraction.warnings);
  if (live !== null && live !== kept) setKept(live);
  const warnings = live ?? kept;

  // Closing the tab or reloading with unsaved edits asks first. Links inside the app are not covered.
  const unsaved = canEdit && methods.formState.isDirty;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    globalThis.addEventListener('beforeunload', warn);
    return () => globalThis.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const currency = values.currency ?? extraction.data.currency;
  const money = useMoney(currency);
  // A half-typed currency ("U") must not flip the digits: until it is a code, keep the loaded one.
  const fractionDigits = minorDigits(
    /^[A-Z]{3}$/.test(currency) ? currency : extraction.data.currency,
  );
  const weak = useMemo(() => weakFields(deferred, warnings), [deferred, warnings]);
  const lineSum = sumOfLines(values.lines ?? []);

  const reasonText = useCallback(
    (r: WeakReason): string => {
      switch (r.kind) {
        case 'lowConfidence':
          return t('reason.lowConfidence', { percent: Math.round(r.confidence * 100) });
        case 'noMeta':
          return t('reason.noMeta');
        case 'warning':
          return t(`warning.${r.code}`, {
            expected: money(r.params.expected ?? Number.NaN),
            actual: money(r.params.actual ?? Number.NaN),
            allowed: r.params.allowed ?? 0,
          });
      }
    },
    [t, money],
  );
  const errorText = useCallback(
    (type: string | undefined) => {
      switch (type) {
        case 'invalid_type':
          return t('errors.invalidType');
        case 'too_small':
          return t('errors.tooSmall');
        case 'too_big':
          return t('errors.tooBig');
        case 'invalid_format':
          return t('errors.invalidFormat');
        default:
          return t('errors.invalid');
      }
    },
    [t],
  );
  const onFocusPath = useCallback(
    (path: string) => {
      const meta = getValues('fieldMeta')[path];
      onEvidence(meta?.evidence ? { ...meta.evidence } : null);
    },
    [getValues, onEvidence],
  );

  const errorCount = Object.keys(methods.formState.errors).length;

  return (
    <ReviewProvider
      value={{ weak, readOnly: !canEdit, fractionDigits, reasonText, onFocusPath, errorText }}
    >
      <FormProvider {...methods}>
        <form
          noValidate
          data-testid="invoice-data"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            void handleSubmit((invoice) => onValid(invoice))(e);
          }}
        >
          <section
            aria-labelledby="warnings-title"
            data-testid="warnings"
            className="rounded-lg border bg-card p-4"
          >
            <h2 id="warnings-title" className="text-base font-semibold">
              {t('warningsTitle', { count: warnings.length })}
            </h2>
            {warnings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noWarnings')}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {warnings.map((w) => (
                  <li key={`${w.code}-${w.path}`} data-code={w.code} data-path={w.path}>
                    <span className="font-medium">{pathLabel(w.path)}</span>
                    {': '}
                    {reasonText({ kind: 'warning', code: w.code, params: w.params })}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t('legend')}</p>
          </section>

          <Card title={td('invoiceInfo')}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <TextField name="invoiceNo" label={td('invoiceNo')} />
              <TextField name="series" label={td('series')} />
              <TextField name="issueDate" label={td('issueDate')} type="date" />
              <TextField name="currency" label={td('currency')} />
            </div>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title={td('seller')} data-testid="seller">
              <TextField name="seller.name" label={td('name')} />
              <TextField name="seller.taxCode" label={td('taxCode')} hint={t('hints.taxCode')} />
              <TextField name="seller.address" label={td('address')} />
            </Card>
            <Card title={td('buyer')} data-testid="buyer">
              <TextField name="buyer.name" label={td('name')} />
              <TextField name="buyer.taxCode" label={td('taxCode')} hint={t('hints.taxCode')} />
              <TextField name="buyer.address" label={td('address')} />
            </Card>
          </div>

          <Lines canEdit={canEdit} />

          <div className="grid gap-4 xl:grid-cols-2">
            <VatRows />
            <Card title={td('totals')}>
              <NumberField
                name="subtotal"
                label={td('subtotal')}
                money
                hint={lineSum === null ? undefined : t('sumOfLines', { amount: money(lineSum) })}
              />
              <NumberField name="total" label={td('total')} money />
            </Card>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {canEdit && (
              <Button type="submit" data-testid="approve-form" disabled={submitting}>
                {submitting ? t('approving') : t('approve')}
              </Button>
            )}
            {!canEdit && (
              <p className="text-sm text-muted-foreground">{readOnlyText ?? t('readOnly')}</p>
            )}
            {errorCount > 0 && (
              <p role="alert" data-testid="form-errors" className="text-sm text-destructive">
                {t('hasErrors', { count: errorCount })}
              </p>
            )}
            {submitError !== null && (
              <p role="alert" data-testid="approve-error" className="text-sm text-destructive">
                {submitError}
              </p>
            )}
          </div>
        </form>
      </FormProvider>
    </ReviewProvider>
  );
}
