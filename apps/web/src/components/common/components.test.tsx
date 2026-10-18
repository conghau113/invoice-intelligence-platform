import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FormField } from './form-field';
import { StatePanel } from './state-panel';
import { DOCUMENT_STATUSES, STATUS_STYLE, StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it.each(DOCUMENT_STATUSES)('%s renders its label, an icon and its status', (status) => {
    const html = renderToStaticMarkup(<StatusBadge status={status} label={`L-${status}`} />);
    expect(html).toContain(`L-${status}`);
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
  });

  it('puts only settled-bad states in the danger tone', () => {
    const danger = DOCUMENT_STATUSES.filter((s) => STATUS_STYLE[s].tone === 'danger');
    expect(danger).toEqual(['rejected', 'failed']);
  });
});

describe('StatePanel', () => {
  it('announces loading politely, error assertively, empty not at all', () => {
    expect(renderToStaticMarkup(<StatePanel kind="loading" title="Wait" />)).toMatch(
      /role="status"[^>]*aria-busy="true"/,
    );
    expect(renderToStaticMarkup(<StatePanel kind="error" title="Boom" />)).toContain(
      'role="alert"',
    );
    const empty = renderToStaticMarkup(<StatePanel kind="empty" title="None" />);
    expect(empty).not.toContain('role=');
    expect(empty).toContain('None');
  });
});

describe('FormField', () => {
  it('ties label, control, hint and error together', () => {
    const html = renderToStaticMarkup(
      <FormField label="Tax code" hint="10 digits" error="Bad digit" required>
        {(c) => <input {...c} />}
      </FormField>,
    );
    const id = /<label[^>]*for="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-hint ${id}-error"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-required="true"');
    expect(html).toContain(`id="${id}-error"`);
  });

  it('adds no aria attributes when there is nothing to describe', () => {
    const html = renderToStaticMarkup(
      <FormField label="Name">{(c) => <input {...c} />}</FormField>,
    );
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('aria-required');
  });
});
