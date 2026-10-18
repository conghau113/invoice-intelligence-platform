import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../db/db.module';
import type { TenantDirectory } from '../application/tenant-directory.port';

/**
 * Looks the alias up through app_resolve_tenant(): a SECURITY DEFINER function, because `tenants`
 * is protected by RLS and no tenant is known yet at this point (see drizzle/0001_rls.sql).
 * Runs on the pool directly, not in a tenant transaction.
 */
@Injectable()
export class PgTenantDirectory implements TenantDirectory {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async idForAlias(alias: string): Promise<string | undefined> {
    try {
      const { rows } = await this.pool.query<{ id: string | null }>(
        'SELECT app_resolve_tenant($1) AS id',
        [alias],
      );
      return rows[0]?.id ?? undefined;
    } catch {
      // Database unreachable: the caller's token is not at fault, so not 401/500.
      throw new ServiceUnavailableException();
    }
  }
}
