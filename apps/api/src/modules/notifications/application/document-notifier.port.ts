import type { DocumentStatus } from '../../documents/domain/document-status';

/** A committed-to-be status change, as DocumentStateMachine saw it under the row lock. */
export interface DocumentTransition {
  tenantId: string;
  documentId: string;
  /** Who uploaded the document: the one who waits for it. */
  uploadedBy: string;
  from: DocumentStatus;
  to: DocumentStatus;
  /** The failure code stored with `failed`, else null. */
  failureCode: string | null;
}

/**
 * Called by DocumentStateMachine INSIDE the transition's transaction (T6.5): whatever it writes
 * commits or rolls back with the status. Pushing to the browser waits for COMMIT.
 */
export interface DocumentNotifier {
  onTransition(change: DocumentTransition): Promise<void>;
}
export const DOCUMENT_NOTIFIER = Symbol('DOCUMENT_NOTIFIER');

/** For code built by hand without notifications (tests that test something else). */
export const NO_NOTIFIER: DocumentNotifier = { onTransition: () => Promise.resolve() };
