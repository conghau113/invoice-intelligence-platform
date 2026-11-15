import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import type { AiIndexer, CurrentInvoiceRow } from '../application/ai-indexer.port';
import { aiIndexResponseSchema, type AiIndexResponse } from '../domain/ai-index-response';
import { RATE_LIMITED_CODE, parseRetryAfterMs, readErrorCode } from '../../extraction/resilience';
import { PermanentIndexError, TransientIndexError } from '../domain/index-job';

/** Statuses where "try again later" is the right answer. */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 429]);
/** Our own settings are wrong (token, URL): an operator can fix it, so retry like extraction does. */
const MISCONFIGURED: ReadonlySet<number> = new Set([401, 403, 404]);

/** Answer of the AI service could not be used: a bug on one side, retrying gets the same answer. */
export const INDEX_RESPONSE_INVALID = 'INDEX_RESPONSE_INVALID';
/** The AI service refused the row (422: it does not match the schema). */
export const INDEX_REQUEST_REJECTED = 'INDEX_REQUEST_REJECTED';

/**
 * POST /index over the internal network with the shared bearer token (API.md). One embedding call
 * per invoice (51 chunks at most, one batch), so the same timeout as an LLM extraction applies.
 * Neither the token, the invoice nor any response body reaches an error message or a log.
 */
@Injectable()
export class HttpAiIndexer implements AiIndexer {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.endpoint = new URL('/index', config.get('AI_SERVICE_URL', { infer: true }));
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
    this.timeoutMs = config.get('AI_LLM_TIMEOUT_MS', { infer: true });
  }

  async index(row: CurrentInvoiceRow): Promise<AiIndexResponse> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        body: JSON.stringify(row),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TransientIndexError(); // refused, reset, DNS or timeout
    }
    if (res.ok) return this.parse(res);
    if (res.status >= 500 || RETRYABLE_4XX.has(res.status) || MISCONFIGURED.has(res.status)) {
      // Only the `code` is taken from the body (at most 4 KiB read, never logged), to tell a
      // provider over its rate limit from one that is down; Retry-After is the wait it named.
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const code = await readErrorCode(res);
      throw new TransientIndexError(code === RATE_LIMITED_CODE || res.status === 429, retryAfterMs);
    }
    // Refused: the body is not needed, release the socket.
    await res.body?.cancel().catch(() => undefined);
    throw new PermanentIndexError(INDEX_REQUEST_REJECTED);
  }

  private async parse(res: Response): Promise<AiIndexResponse> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new TransientIndexError(); // body cut off, like a timeout
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PermanentIndexError(INDEX_RESPONSE_INVALID);
    }
    const parsed = aiIndexResponseSchema.safeParse(body);
    // The zod message would echo chunk text, so only the code leaves here.
    if (!parsed.success) throw new PermanentIndexError(INDEX_RESPONSE_INVALID);
    return parsed.data;
  }
}
