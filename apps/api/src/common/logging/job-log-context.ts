import { runWithLogContext } from 'logger';
import { isUuid } from '../uuid';

/**
 * Runs `fn` so that its log lines carry the job's tenant (T7.2). Job data comes from Redis and is
 * validated later by the processor; here only a well-formed uuid is taken, anything else is left out.
 */
export function withJobLogContext<T>(data: unknown, fn: () => T): T {
  const tenantId =
    typeof data === 'object' && data !== null && 'tenantId' in data ? data.tenantId : undefined;
  return typeof tenantId === 'string' && isUuid(tenantId)
    ? runWithLogContext({ tenantId }, fn)
    : fn();
}
