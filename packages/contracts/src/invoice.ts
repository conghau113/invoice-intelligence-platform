import { z } from 'zod';

// Money = integer minor units (VND: đồng, USD: cent); dates = ISO 8601 (ADR 0004 / CLAUDE.md).
// "No value" is always `null` with the key present, never an absent key: Zod, JSON Schema and
// the generated pydantic model then agree (pydantic would accept null for an optional key
// that Zod rejects). Business rules (sums, VAT, future dates) live in T3.3, not here.

const Money = z.int();

// [0-9] not \d: Python's regex engines match Unicode digits for \d, JS does not.
const TAX_CODE = /^[0-9]{10}(-[0-9]{3})?$/;

export const PartySchema = z
  .strictObject({
    name: z.string().min(1),
    taxCode: z.string().regex(TAX_CODE),
    address: z.string().min(1),
  })
  .meta({ id: 'Party' });

// Individual buyers usually have no tax code; forcing one would make an LLM invent it.
export const BuyerSchema = z
  .strictObject({
    name: z.string().min(1),
    taxCode: z.string().regex(TAX_CODE).nullable(),
    address: z.string().min(1),
  })
  .meta({ id: 'Buyer' });

export const InvoiceLineSchema = z
  .strictObject({
    description: z.string().min(1),
    quantity: z.number().positive(),
    unit: z.string().min(1),
    unitPrice: Money,
    vatRate: z.number().min(0).max(100),
    amount: Money,
  })
  .meta({ id: 'InvoiceLine' });

export const VatBreakdownSchema = z
  .strictObject({
    rate: z.number().min(0).max(100),
    base: Money,
    amount: Money,
  })
  .meta({ id: 'VatBreakdownItem' });

// Every addressable field of an Invoice. Rule warnings (T3.3) and field corrections (T3.5)
// use the same grammar. Keep in sync with InvoiceSchema (a test walks a fixture to check).
export const FIELD_PATH_PATTERN =
  /^(?:(?:seller|buyer)\.(?:name|taxCode|address)|invoiceNo|series|issueDate|currency|subtotal|total|lines\.(?:0|[1-9][0-9]*)\.(?:description|quantity|unit|unitPrice|vatRate|amount)|vatBreakdown\.(?:0|[1-9][0-9]*)\.(?:rate|base|amount))$/;

// No `.meta({id})` here: pydantic would generate an unhashable RootModel unusable as a dict key.
export const FieldPathSchema = z.string().regex(FIELD_PATH_PATTERN);

// `text` is an excerpt of the document: it is data, never log it (CLAUDE.md).
export const EvidenceSchema = z
  .strictObject({
    page: z.int().min(1),
    text: z.string().min(1).max(500),
  })
  .meta({ id: 'Evidence' });

export const FieldMetaSchema = z
  .strictObject({
    confidence: z.number().min(0).max(1),
    evidence: EvidenceSchema.nullable(),
  })
  .meta({ id: 'FieldMeta' });

export const InvoiceSchema = z.strictObject({
  seller: PartySchema,
  buyer: BuyerSchema,
  invoiceNo: z.string().min(1),
  series: z.string().min(1),
  issueDate: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(InvoiceLineSchema).min(1),
  subtotal: Money,
  vatBreakdown: z.array(VatBreakdownSchema),
  total: Money,
  // Not required to cover every field (a record cannot enforce that for variable-length lines).
  fieldMeta: z.record(FieldPathSchema, FieldMetaSchema),
});

export type Invoice = z.infer<typeof InvoiceSchema>;
export type FieldMeta = z.infer<typeof FieldMetaSchema>;
