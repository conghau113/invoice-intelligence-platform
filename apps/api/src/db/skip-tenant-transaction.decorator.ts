import { SetMetadata } from '@nestjs/common';

export const SKIP_TENANT_TRANSACTION = 'skipTenantTransaction';

/**
 * Opts a route out of the request-wide tenant transaction. For handlers that do slow I/O (an
 * upload streaming to disk) and would otherwise hold a pooled connection the whole time: they open
 * short transactions with `TenantDbService.run` themselves. The route is still authenticated.
 */
export const SkipTenantTransaction = (): MethodDecorator =>
  SetMetadata(SKIP_TENANT_TRANSACTION, true);
