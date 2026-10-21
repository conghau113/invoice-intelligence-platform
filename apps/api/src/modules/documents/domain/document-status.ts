export const DOCUMENT_STATUSES = [
  'uploaded',
  'queued',
  'processing',
  'needs_review',
  'approved',
  'rejected',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Every document starts here ([*] --> uploaded in ARCHITECTURE.md section 8). */
export const INITIAL_STATUS: DocumentStatus = 'uploaded';

/**
 * The valid transitions of ARCHITECTURE.md section 8, one row per state. `rejected` is terminal
 * and `approved` can only be reopened. Everything not listed here is invalid.
 */
const TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  uploaded: ['queued', 'rejected'],
  queued: ['processing'],
  processing: ['needs_review', 'queued', 'failed'],
  failed: ['queued'],
  needs_review: ['approved'],
  approved: ['needs_review'],
  rejected: [],
};

/** Stable machine-readable reason; ProblemDetailsFilter maps the error to 409 for every route. */
export const INVALID_TRANSITION_CODE = 'INVALID_DOCUMENT_TRANSITION';

export class InvalidDocumentTransitionError extends Error {
  readonly code = INVALID_TRANSITION_CODE;

  constructor(
    readonly from: DocumentStatus,
    readonly to: DocumentStatus,
  ) {
    super(`Invalid document transition ${from} -> ${to}`);
    this.name = 'InvalidDocumentTransitionError';
  }
}

export const isDocumentStatus = (value: unknown): value is DocumentStatus =>
  (DOCUMENT_STATUSES as readonly unknown[]).includes(value);

export const canTransition = (from: DocumentStatus, to: DocumentStatus): boolean =>
  TRANSITIONS[from].includes(to);

/** Throws a domain error for any pair that is not an edge of the state machine. */
export function assertTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!canTransition(from, to)) throw new InvalidDocumentTransitionError(from, to);
}

/** Reopening an approved document starts a new version; every other transition keeps it. */
export const nextVersion = (from: DocumentStatus, to: DocumentStatus, version: number): number =>
  from === 'approved' && to === 'needs_review' ? version + 1 : version;
