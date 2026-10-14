import { z } from 'zod';

// DRAFT (T0.5): shape from AI_PIPELINE §3 only. Business rules and fieldMeta land in T2.7.
// Money = integer minor units; dates = ISO 8601 (ADR 0004 / CLAUDE.md).

const Money = z.int();

export const PartySchema = z.strictObject({
  name: z.string().min(1),
  taxCode: z.string().regex(/^\d{10}(-\d{3})?$/),
  address: z.string().min(1),
});

export const InvoiceLineSchema = z.strictObject({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  unitPrice: Money,
  vatRate: z.number().min(0).max(100),
  amount: Money,
});

export const VatBreakdownSchema = z.strictObject({
  rate: z.number().min(0).max(100),
  base: Money,
  amount: Money,
});

export const InvoiceDraftSchema = z.strictObject({
  seller: PartySchema,
  buyer: PartySchema,
  invoiceNo: z.string().min(1),
  series: z.string().min(1),
  issueDate: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(InvoiceLineSchema).min(1),
  subtotal: Money,
  vatBreakdown: z.array(VatBreakdownSchema),
  total: Money,
});

export type InvoiceDraft = z.infer<typeof InvoiceDraftSchema>;
