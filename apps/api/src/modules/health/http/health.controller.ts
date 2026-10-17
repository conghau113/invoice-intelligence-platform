import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/http/public.decorator';

// Probes are called by the orchestrator without a token.
@Public()
@Controller('health')
export class HealthController {
  /** Liveness: the process is up. Must not depend on DB/Redis, or an outage would restart us. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: can serve traffic. DB/Redis checks are added in later tasks (T1.3, T2.4). */
  @Get('ready')
  ready(): { status: 'ok'; checks: Record<string, never> } {
    return { status: 'ok', checks: {} };
  }
}
