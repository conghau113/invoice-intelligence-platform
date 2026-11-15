import { Global, Module, type Provider, type Type } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { ProblemDetailsFilter } from '../../src/common/http/problem-details.filter';
import * as schema from '../../src/db/schema';
import { CACHE_ENABLED, CACHE_STORE } from '../../src/modules/cache/application/cache-store.port';
import { EXTRACTION_CACHE_OPTIONS } from '../../src/modules/cache/application/extraction-result-cache';
import { MemoryCacheStore } from '../../src/modules/cache/testing/memory-cache-store';
import { DB, TenantDbService } from '../../src/db/tenant-db.service';
import { TenantTransactionInterceptor } from '../../src/db/tenant-transaction.interceptor';
import { TENANT_DIRECTORY } from '../../src/modules/auth/application/tenant-directory.port';
import { TOKEN_VERIFIER } from '../../src/modules/auth/application/token-verifier.port';
import { JwtAuthGuard } from '../../src/modules/auth/http/jwt-auth.guard';
import { PermissionsGuard } from '../../src/modules/auth/http/permissions.guard';

/**
 * A global module with the real database (app role, RLS), the per-request tenant transaction and a
 * fixed config: what an integration test needs under the feature modules it imports.
 */
export function realDbModule(pool: Pool, env: Record<string, unknown>): Type {
  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: drizzle(pool, { schema }) },
      TenantDbService,
      { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
      { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
    ],
    exports: [DB, TenantDbService, ConfigService],
  })
  class RealDbModule {}
  return RealDbModule;
}

/**
 * The real authentication and permission guards and the Problem Details filter, with the token
 * check stubbed: the bearer token "<role>@<tenant alias>" (alias `acme` when left out) is user `sub`
 * in that tenant. Aliases map to tenant ids through `tenants`; an unknown alias is not a tenant.
 */
export function stubAuthProviders(sub: string, tenants: Record<string, string>): Provider[] {
  return [
    {
      provide: TOKEN_VERIFIER,
      useValue: {
        verify: (token: string) => {
          const [role, alias = 'acme'] = token.split('@');
          return Promise.resolve({ sub, organization: [alias], realm_access: { roles: [role] } });
        },
      },
    },
    {
      provide: TENANT_DIRECTORY,
      useValue: { idForAlias: (a: string) => Promise.resolve(tenants[a]) },
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ];
}

/**
 * Deletes every document a test user uploaded and all that hangs off it, children first, as the
 * owner (the app role may not delete most of these rows).
 */
export async function deleteDocumentsOf(owner: Pool, user: string): Promise<void> {
  const mine = `SELECT id FROM documents WHERE uploaded_by = $1`;
  await owner.query(`DELETE FROM chunks WHERE document_id IN (${mine})`, [user]);
  await owner.query(
    `DELETE FROM field_corrections WHERE extraction_id IN
       (SELECT id FROM extractions WHERE document_id IN (${mine}))`,
    [user],
  );
  await owner.query(
    `DELETE FROM invoice_lines WHERE invoice_id IN
       (SELECT id FROM invoices WHERE document_id IN (${mine}))`,
    [user],
  );
  await owner.query(`DELETE FROM invoices WHERE document_id IN (${mine})`, [user]);
  await owner.query(`DELETE FROM extractions WHERE document_id IN (${mine})`, [user]);
  await owner.query(`DELETE FROM audit_logs WHERE entity_id IN (${mine})`, [user]);
  await owner.query(`DELETE FROM documents WHERE uploaded_by = $1`, [user]);
}

/**
 * Provider limits that never slow a test down and a breaker that never opens: for integration
 * tests about something else. The pacing and the breaker have their own test (resilience.int-spec).
 */
export const UNLIMITED_PROVIDER = {
  LLM_RPM: 100_000,
  LLM_TPM: 100_000_000,
  EMBED_RPM: 100_000,
  EMBED_TPM: 100_000_000,
  PROVIDER_MINUTE_MS: 100,
  BREAKER_THRESHOLD: 100,
  BREAKER_COOLDOWN_MS: 100,
};

/**
 * The caches of T6.3 switched off, for integration tests about something else: they write rows
 * straight into the database (as the owner), which no cache can know about, and they have no Redis.
 * Caching itself is tested with real Redis in cache.int-spec.
 */
export const withoutCache = (builder: TestingModuleBuilder): TestingModuleBuilder =>
  builder
    .overrideProvider(CACHE_STORE)
    .useValue(new MemoryCacheStore())
    .overrideProvider(CACHE_ENABLED)
    .useValue(false)
    .overrideProvider(EXTRACTION_CACHE_OPTIONS)
    .useValue({ resultTtlMs: 1, lockTtlMs: 1, pollMs: 1 });
