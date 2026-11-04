import type { Invoice } from 'contracts';
import { createFormControl } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { loadInvoiceFixture } from '../documents/detail/detail-fixtures';
import {
  invoiceResolver,
  liveWarnings,
  sumOfLines,
  toFormValues,
  toInvoice,
  type FormValues,
} from './form-values';

const invoice = () => loadInvoiceFixture() as unknown as Invoice;
const TODAY = '2026-11-03';

function form(values: FormValues = toFormValues(invoice())) {
  return createFormControl<FormValues, unknown, Invoice>({
    defaultValues: values,
    resolver: invoiceResolver,
  });
}

describe('toFormValues / toInvoice', () => {
  it('round-trips, with a missing buyer tax code as an empty box and back to null', () => {
    const inv = { ...invoice(), buyer: { ...invoice().buyer, taxCode: null } };
    const values = toFormValues(inv);
    expect(values.buyer.taxCode).toBe('');
    expect(toInvoice(values)).toEqual(inv);
  });
  it('a blank box (spaces) is null too', () => {
    const v = toFormValues(invoice());
    v.buyer.taxCode = '   ';
    expect(toInvoice(v).buyer.taxCode).toBeNull();
  });
});

describe('the form cannot be submitted with schema errors', () => {
  it('a valid form reaches the success callback with the Invoice', async () => {
    const f = form();
    const ok = vi.fn();
    const bad = vi.fn();
    await f.handleSubmit(ok, bad)();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(bad).not.toHaveBeenCalled();
    expect(ok.mock.calls[0]![0]).toEqual(invoice());
  });

  it('a malformed tax code stops it, and the error is on that field', async () => {
    const f = form();
    f.setValue('seller.taxCode', '12345');
    const ok = vi.fn();
    const bad = vi.fn();
    await f.handleSubmit(ok, bad)();
    expect(ok).not.toHaveBeenCalled();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(Object.keys(bad.mock.calls[0]![0].seller ?? {})).toContain('taxCode');
  });

  it('a number box holding NaN (text that is not a number) stops it', async () => {
    const f = form();
    f.setValue('lines.0.unitPrice', Number.NaN);
    const ok = vi.fn();
    await f.handleSubmit(ok, vi.fn())();
    expect(ok).not.toHaveBeenCalled();
  });

  it('an empty line list stops it', async () => {
    const f = form();
    f.setValue('lines', []);
    const ok = vi.fn();
    await f.handleSubmit(ok, vi.fn())();
    expect(ok).not.toHaveBeenCalled();
  });
});

describe('liveWarnings: editing a line updates the warnings', () => {
  const values = () => toFormValues(invoice());
  const codes = (v: FormValues) => (liveWarnings(v, TODAY) ?? []).map((w) => `${w.code}@${w.path}`);

  it('is clean for the fixture', () => {
    expect(liveWarnings(values(), TODAY)).toEqual([]);
  });

  it('a changed line amount raises the line and the sum warnings, and fixing it clears them', () => {
    const v = values();
    const original = v.lines[0]!.amount;
    v.lines[0]!.amount = original + 5000;
    expect(codes(v)).toContain('LINE_AMOUNT_MISMATCH@lines.0.amount');
    expect(codes(v)).toContain('LINES_SUM_MISMATCH@subtotal');

    v.lines[0]!.amount = original;
    expect(liveWarnings(v, TODAY)).toEqual([]);
  });

  it('is null while the values do not pass the schema, so the caller keeps the last warnings', () => {
    const v = values();
    v.lines[0]!.amount = Number.NaN;
    expect(liveWarnings(v, TODAY)).toBeNull();
  });

  it('never changes the numbers it checks', () => {
    const v = values();
    v.lines[0]!.amount = 1;
    const before = structuredClone(v);
    liveWarnings(v, TODAY);
    expect(v).toEqual(before);
  });
});

describe('sumOfLines', () => {
  it('adds the amounts, and is null if one is not a number yet', () => {
    expect(sumOfLines([{ amount: 100 }, { amount: 250 }])).toBe(350);
    expect(sumOfLines([{ amount: 100 }, { amount: Number.NaN }])).toBeNull();
  });
});
