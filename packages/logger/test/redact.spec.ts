import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSensitiveKey, redactString, redactValue, REDACTED } from '../src';

interface Case {
  why: string;
  input: string;
  expected?: string;
}
const cases = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'redaction-cases.json'), 'utf8'),
) as { redact: Case[]; keep: Case[] };

describe('redactString (shared cases, also run by apps/ai)', () => {
  it.each(cases.redact.map((c) => [c.why, c] as const))('redacts: %s', (_why, c) => {
    expect(redactString(c.input)).toBe(c.expected);
  });

  it.each(cases.keep.map((c) => [c.why, c] as const))('keeps: %s', (_why, c) => {
    expect(redactString(c.input)).toBe(c.input);
  });

  it('stays fast on a long hostile line (bounded patterns)', () => {
    const line = `${'Nguyễn '.repeat(5_000)}${'a@'.repeat(5_000)}${'0'.repeat(20_000)}`;
    const started = performance.now();
    redactString(line);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('redactValue', () => {
  it('drops the value of fields named after personal data, at any depth', () => {
    const out = redactValue({
      documentId: 'd-1',
      seller: { name: 'Anything', taxCode: '6904000855', address: '1 Main St' },
      buyer_email: 'x',
      items: [{ contactPhone: '1' }],
      status: 'ok',
    });
    expect(out).toEqual({
      documentId: 'd-1',
      seller: REDACTED,
      buyer_email: REDACTED,
      items: [{ contactPhone: REDACTED }],
      status: 'ok',
    });
  });

  it('keeps ids, codes and numbers', () => {
    expect(['documentId', 'code', 'ms', 'jobName', 'queue', 'service'].some(isSensitiveKey)).toBe(
      false,
    );
    expect(redactValue({ ms: 12, ok: true, none: null })).toEqual({ ms: 12, ok: true, none: null });
  });

  it('turns an error into data with its message and stack redacted', () => {
    const err = Object.assign(new TypeError('bad seller Nguyễn Văn Jane SAMPLE, MST 6904000855'), {
      code: '23505',
    });
    const out = redactValue(err) as Record<string, string>;
    expect(out.type).toBe('TypeError');
    expect(out.code).toBe('23505');
    expect(out.message).toBe('bad seller [NAME], MST [TAX_CODE]');
    expect(out.stack).not.toContain('6904000855');
    expect(out.stack).not.toContain('Nguyễn');
  });

  it('copies an object seen twice side by side, and hides binary data', () => {
    const shared = { k: 1 };
    expect(redactValue({ x: shared, y: shared })).toEqual({ x: { k: 1 }, y: { k: 1 } });
    expect(redactValue({ file: Buffer.from('Nguyễn Văn Jane SAMPLE') })).toEqual({
      file: '[Binary]',
    });
  });

  it('survives cycles and deep nesting', () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    expect(redactValue(a)).toEqual({ id: 1, self: '[Circular]' });
    let deep: Record<string, unknown> = { v: 'x' };
    for (let i = 0; i < 20; i += 1) deep = { deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[Truncated]');
  });
});
