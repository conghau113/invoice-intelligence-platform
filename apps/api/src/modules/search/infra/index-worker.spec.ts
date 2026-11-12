import { UnrecoverableError } from 'bullmq';
import { INDEX_FAILED, INDEX_RETRY, IndexJobError } from '../domain/index-job';
import { causeOf, toQueueError } from './index-worker';

describe('toQueueError: what BullMQ stores for a failed index attempt', () => {
  it('a non-retryable job error stops the retries, with its code', () => {
    const out = toQueueError(new IndexJobError('INDEX_RESPONSE_MISMATCH', false));
    expect(out).toBeInstanceOf(UnrecoverableError);
    expect(out.message).toBe('INDEX_RESPONSE_MISMATCH');
  });

  it('a retryable job error is passed on and retried', () => {
    const err = new IndexJobError(INDEX_RETRY, true);
    const out = toQueueError(err);
    expect(out).toBe(err);
    expect(out).not.toBeInstanceOf(UnrecoverableError);
  });

  it('any other error is retried under a fixed code, its message dropped', () => {
    const out = toQueueError(new Error('duplicate key value (SAMPLE content)'));
    expect(out).not.toBeInstanceOf(UnrecoverableError);
    expect(out.message).toBe(INDEX_FAILED);
  });
});

describe('causeOf: what the worker logs about an unexpected error', () => {
  it('a Postgres error: class and SQLSTATE, never the message', () => {
    const err = Object.assign(new Error('Key (content)=(SAMPLE) already exists'), {
      name: 'DatabaseError',
      code: '23505',
    });
    expect(causeOf(err)).toBe('DatabaseError/23505');
  });

  it('a code that is not a SQLSTATE is left out', () => {
    const err = Object.assign(new Error('x'), { code: 'ECONNRESET SAMPLE' });
    expect(causeOf(err)).toBe('Error');
  });

  it('a thrown non-error', () => {
    expect(causeOf('SAMPLE')).toBe('unknown');
  });
});
