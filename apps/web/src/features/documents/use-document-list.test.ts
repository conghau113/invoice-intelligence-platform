import { describe, expect, it } from 'vitest';
import type { DocumentPage } from './list-client';
import { POLL_MS, refetchIntervalFor } from './use-document-list';

const page = (...statuses: DocumentPage['items'][number]['status'][]): DocumentPage => ({
  items: statuses.map((status, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    status,
    sourceType: 'xml',
    version: 1,
    createdAt: '2026-10-22T03:00:00.000Z',
  })),
  meta: { page: 1, limit: 20, total: statuses.length, totalPages: 1 },
});

describe('refetchIntervalFor', () => {
  it.each(['uploaded', 'queued', 'processing'] as const)(
    'polls while a %s document is shown',
    (s) => {
      expect(refetchIntervalFor(page('approved', s))).toBe(POLL_MS);
    },
  );

  it('is 5 seconds', () => expect(POLL_MS).toBe(5000));

  it('stops when everything on the page has settled', () => {
    expect(refetchIntervalFor(page('needs_review', 'approved', 'rejected', 'failed'))).toBe(false);
    expect(refetchIntervalFor(page())).toBe(false);
  });

  it('does not poll before the first answer', () => {
    expect(refetchIntervalFor(undefined)).toBe(false);
  });
});
