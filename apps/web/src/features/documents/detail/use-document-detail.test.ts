import { describe, expect, it } from 'vitest';
import type { DocumentDetail } from './detail-client';
import { DETAIL_POLL_MS, refetchIntervalFor } from './use-document-detail';

const doc = (status: DocumentDetail['status']) => ({ status }) as DocumentDetail;

describe('refetchIntervalFor', () => {
  it('polls while the worker can still change the document', () => {
    for (const s of ['uploaded', 'queued', 'processing'] as const) {
      expect(refetchIntervalFor(doc(s))).toBe(DETAIL_POLL_MS);
    }
  });
  it('stops once the document has settled, and before the first answer', () => {
    for (const s of ['needs_review', 'approved', 'rejected', 'failed'] as const) {
      expect(refetchIntervalFor(doc(s))).toBe(false);
    }
    expect(refetchIntervalFor(undefined)).toBe(false);
  });
});
