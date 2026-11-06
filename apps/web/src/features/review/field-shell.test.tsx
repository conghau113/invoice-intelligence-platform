import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DateInput } from './date-input';
import { FieldShell } from './field-shell';
import { ReviewProvider } from './review-context';
import type { WeakReason } from './weak-fields';

const render = (reasons: WeakReason[], hideLabel = false) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ReviewProvider
        value={{
          weak: new Map([['total', reasons]]),
          readOnly: false,
          fractionDigits: 0,
          reasonText: (r) => `reason:${r.kind}`,
          onFocusPath: () => undefined,
          errorText: () => 'error',
        }}
      >
        <FieldShell path="total" label="Total" hideLabel={hideLabel}>
          {(control) => <input {...control} />}
        </FieldShell>
      </ReviewProvider>
    </TooltipProvider>,
  );

describe('FieldShell marks', () => {
  it('no confidence: a dashed frame and a description, nothing that looks like a warning', () => {
    const html = render([{ kind: 'noMeta' }]);
    expect(html).toContain('data-no-meta="true"');
    expect(html).toContain('border-dashed');
    expect(html).toMatch(/class="sr-only"[^>]*>reason:noMeta/);
    expect(html).not.toContain('data-weak');
    expect(html).not.toContain('bg-warning-soft');
    expect(html).not.toContain('border-warning');
    expect(html).not.toContain('text-warning');
    expect(html).not.toContain('<svg');
  });

  it.each<[string, WeakReason]>([
    ['low confidence', { kind: 'lowConfidence', confidence: 0.5 }],
    ['a broken rule', { kind: 'warning', code: 'TOTAL_MISMATCH', params: {} }],
  ])('%s: yellow frame, icon and reason', (_name, reason) => {
    const html = render([reason]);
    expect(html).toContain('data-weak="true"');
    expect(html).toContain('bg-warning-soft');
    expect(html).toContain('data-testid="weak-icon"');
    expect(html).toContain(`reason:${reason.kind}`);
  });

  it('no reason: no frame at all, and nothing in the markup to read as "checked"', () => {
    const html = render([]);
    expect(html).not.toContain('data-weak');
    expect(html).not.toContain('data-no-meta');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('<svg');
  });

  it('the reason describes the control, also in a table where it is not shown as text', () => {
    const html = render([{ kind: 'noMeta' }], true);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toMatch(new RegExp(`id="${describedBy}" class="sr-only"`));
  });
});

describe('DateInput', () => {
  const renderDate = (value: string, locale: string, readOnly = false) =>
    renderToStaticMarkup(
      <DateInput
        id="d"
        value={value}
        locale={locale}
        pickLabel="Pick"
        readOnly={readOnly}
        onChange={() => undefined}
      />,
    );

  it('shows the ISO value in the interface language; the calendar still gets ISO', () => {
    const html = renderDate('2026-01-08', 'vi');
    expect(html).toContain('value="08/01/2026"');
    expect(html).toContain('value="2026-01-08"');
    expect(renderDate('2026-01-08', 'en')).toContain('value="01/08/2026"');
  });

  it('has no calendar on a read-only form', () => {
    const html = renderDate('2026-01-08', 'vi', true);
    expect(html).toContain('value="08/01/2026"');
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('<button');
  });
});
