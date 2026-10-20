import {
  assertTransition,
  canTransition,
  DOCUMENT_STATUSES,
  InvalidDocumentTransitionError,
  nextVersion,
  type DocumentStatus,
} from './document-status';

// Written out by hand from ARCHITECTURE.md section 8, NOT derived from the implementation.
const VALID: ReadonlyArray<readonly [DocumentStatus, DocumentStatus]> = [
  ['uploaded', 'queued'],
  ['uploaded', 'rejected'],
  ['queued', 'processing'],
  ['processing', 'needs_review'],
  ['processing', 'queued'],
  ['processing', 'failed'],
  ['failed', 'queued'],
  ['needs_review', 'approved'],
  ['approved', 'needs_review'],
];
const key = (a: string, b: string) => `${a}->${b}`;
const validKeys = new Set(VALID.map(([a, b]) => key(a, b)));
const ALL_PAIRS = DOCUMENT_STATUSES.flatMap((a) => DOCUMENT_STATUSES.map((b) => [a, b] as const));
const INVALID = ALL_PAIRS.filter(([a, b]) => !validKeys.has(key(a, b)));

describe('document state machine', () => {
  it('covers all 49 pairs', () => {
    expect(ALL_PAIRS).toHaveLength(49);
    expect(VALID).toHaveLength(9);
    expect(INVALID).toHaveLength(40);
  });

  it.each(VALID)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(INVALID)('rejects %s -> %s with a domain error', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidDocumentTransitionError);
    try {
      assertTransition(from, to);
    } catch (e) {
      expect(e).toMatchObject({ code: 'INVALID_DOCUMENT_TRANSITION', from, to });
    }
  });

  it('bumps the version only when an approved document is reopened', () => {
    expect(nextVersion('approved', 'needs_review', 1)).toBe(2);
    for (const [from, to] of ALL_PAIRS) {
      if (from === 'approved' && to === 'needs_review') continue;
      expect(nextVersion(from, to, 3)).toBe(3);
    }
  });
});
