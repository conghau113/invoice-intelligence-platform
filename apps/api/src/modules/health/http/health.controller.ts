import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../db/db.module';
import { Public } from '../../auth/http/public.decorator';

const READY_TIMEOUT_MS = 2_000;

// Probes are called by the orchestrator without a token.
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Liveness: the process is up. Must not depend on DB/Redis, or an outage would restart us. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: can serve traffic. Redis is added in T2.4. 503 (no detail) when the DB is down. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: { database: 'ok' } }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.pool.query('SELECT 1'), timeout]);
    } catch {
      throw new ServiceUnavailableException();
    } finally {
      clearTimeout(timer);
    }
    return { status: 'ok', checks: { database: 'ok' } };
  }
}
