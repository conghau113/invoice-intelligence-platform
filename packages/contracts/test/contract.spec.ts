import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvoiceDraftSchema } from '../src';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));

describe('InvoiceDraftSchema (shared fixtures; Python runs the same files)', () => {
  it('accepts the valid fixture', () => {
    expect(InvoiceDraftSchema.safeParse(load('invoice.valid.json')).success).toBe(true);
  });

  it('rejects the invalid fixture', () => {
    expect(InvoiceDraftSchema.safeParse(load('invoice.invalid.json')).success).toBe(false);
  });

  it('rejects fractional money', () => {
    const doc = { ...(load('invoice.valid.json') as object), total: 10.5 };
    expect(InvoiceDraftSchema.safeParse(doc).success).toBe(false);
  });

  it('rejects unknown keys (untrusted LLM output; Python forbids extras too)', () => {
    const doc = { ...(load('invoice.valid.json') as object), surprise: 1 };
    expect(InvoiceDraftSchema.safeParse(doc).success).toBe(false);
  });
});
