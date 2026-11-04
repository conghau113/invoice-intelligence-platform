import { invoiceFieldPaths, type FieldMeta, type Invoice, type RuleWarning } from 'contracts';

/** Below this the AI is not sure enough: the field is highlighted for the reviewer (T3.4 spec). */
export const LOW_CONFIDENCE = 0.8;

export type WeakReason =
  | { kind: 'lowConfidence'; confidence: number }
  /** The AI gave no confidence for this field (LLMs often skip some); unknown is treated as weak. */
  | { kind: 'noMeta' }
  | { kind: 'warning'; code: RuleWarning['code']; params: RuleWarning['params'] };

/**
 * Which fields the reviewer should look at, and why. A pure function of the current form values
 * and the live warnings. Paths come from `invoiceFieldPaths`, so a line the user just added (no
 * meta) is listed too.
 */
export function weakFields(
  invoice: Pick<Invoice, 'lines' | 'vatBreakdown' | 'seller' | 'buyer' | 'fieldMeta'>,
  warnings: readonly RuleWarning[],
): Map<string, WeakReason[]> {
  const out = new Map<string, WeakReason[]>();
  const add = (path: string, reason: WeakReason) =>
    out.set(path, [...(out.get(path) ?? []), reason]);

  const meta: Record<string, FieldMeta | undefined> = invoice.fieldMeta;
  for (const path of invoiceFieldPaths(invoice as Invoice)) {
    const m = meta[path];
    if (m === undefined) add(path, { kind: 'noMeta' });
    else if (m.confidence < LOW_CONFIDENCE) {
      add(path, { kind: 'lowConfidence', confidence: m.confidence });
    }
  }
  for (const w of warnings) add(w.path, { kind: 'warning', code: w.code, params: w.params });
  return out;
}

/**
 * The meta of `lines.<i>.*` after line `removed` is deleted: its entries go, later lines move up
 * one index. Without this, "the AI was unsure about line 2" would end up on the wrong line.
 */
export function shiftLineMeta(
  fieldMeta: Record<string, FieldMeta>,
  removed: number,
): Record<string, FieldMeta> {
  const out: Record<string, FieldMeta> = {};
  for (const [path, m] of Object.entries(fieldMeta)) {
    const hit = /^lines\.(\d+)\.(.+)$/.exec(path);
    if (!hit) {
      out[path] = m;
      continue;
    }
    const i = Number(hit[1]);
    if (i === removed) continue;
    out[i > removed ? `lines.${i - 1}.${hit[2]}` : path] = m;
  }
  return out;
}
