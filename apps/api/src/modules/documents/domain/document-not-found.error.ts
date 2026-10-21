/** RLS hides other tenants' rows, so "not yours" and "not there" are the same error. */
export class DocumentNotFoundError extends Error {
  readonly code = 'DOCUMENT_NOT_FOUND';

  constructor() {
    super('Document not found');
    this.name = 'DocumentNotFoundError';
  }
}
