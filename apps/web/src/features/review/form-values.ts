import { zodResolver } from '@hookform/resolvers/zod';
import { InvoiceSchema, type Invoice, type RuleWarning, checkInvoice } from 'contracts';
import type { Resolver } from 'react-hook-form';

/**
 * What the form holds. It is the Invoice, except the buyer's tax code: an empty text box cannot
 * be `null`, so the form keeps '' and `toInvoice` turns it back into null. Everything else is the
 * contracts type unchanged, which is why the schema can validate it.
 */
export type FormValues = Omit<Invoice, 'buyer'> & {
  buyer: Omit<Invoice['buyer'], 'taxCode'> & { taxCode: string };
};

export const toFormValues = (invoice: Invoice): FormValues => ({
  ...invoice,
  buyer: { ...invoice.buyer, taxCode: invoice.buyer.taxCode ?? '' },
});

/** Form values as the contracts type (not yet validated: a number box may hold NaN). */
export const toInvoice = (values: FormValues): Invoice => ({
  ...values,
  buyer: {
    ...values.buyer,
    taxCode: values.buyer.taxCode.trim() === '' ? null : values.buyer.taxCode,
  },
});

const schemaResolver = zodResolver(InvoiceSchema);

/**
 * The same schema the worker and the API validate with (packages/contracts). A form with schema
 * errors cannot be submitted: `handleSubmit` never calls the success callback.
 */
export const invoiceResolver: Resolver<FormValues, unknown, Invoice> = (values, context, options) =>
  // `as never`: zodResolver is typed for the Invoice shape and `options.fields` for FormValues
  // (they differ only in buyer.taxCode, which toInvoice already converted); both are the same at runtime.
  schemaResolver(toInvoice(values), context, options as never) as ReturnType<
    Resolver<FormValues, unknown, Invoice>
  >;

/**
 * Business-rule warnings for what is in the form right now (T3.3 rules, the same function the
 * worker runs). `null` while the values do not pass the schema (a half-typed number): the rules
 * are defined on a valid Invoice, so the caller keeps showing the last warnings and the schema
 * errors explain what is wrong.
 */
export function liveWarnings(values: FormValues, today: string): RuleWarning[] | null {
  const parsed = InvoiceSchema.safeParse(toInvoice(values));
  return parsed.success ? checkInvoice(parsed.data, today) : null;
}

/** Sum of the line amounts, shown next to the subtotal. `null` if any amount is not a number yet. Never written back (PRD 5.4). */
export function sumOfLines(lines: readonly { amount: number }[]): number | null {
  return lines.every((l) => Number.isSafeInteger(l.amount))
    ? lines.reduce((s, l) => s + l.amount, 0)
    : null;
}
