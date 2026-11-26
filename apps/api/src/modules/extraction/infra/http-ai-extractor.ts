import { Injectable } from '@nestjs/common';
import { activeTraceparent } from '../../../common/otel/trace-context';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import {
  EXTRACTION_FAILED,
  PermanentExtractionError,
  TransientExtractionError,
} from '../../queue/domain/extraction-job';
import { z } from 'zod';
import { isExtractionVersion, type ExtractionVersion } from '../../cache/domain/cache-keys';
import type { AiExtractInput, AiExtractor } from '../application/ai-extractor.port';
import { aiExtractResponseSchema, type AiExtractResponse } from '../domain/ai-extract-response';
import {
  AI_SERVICE_MISCONFIGURED,
  EXTRACTION_SCHEMA_INVALID,
  isFailureCode,
} from '../domain/ai-errors';
import { RATE_LIMITED_CODE, parseRetryAfterMs, readErrorCode } from '../resilience';

/** One XML parse takes milliseconds. */
const XML_TIMEOUT_MS = 15_000;

/**
 * PDF/image go through an LLM (seconds to tens of seconds). The AI service stops itself at 55 s
 * (`TOTAL_BUDGET_S`), so 60 s lets it answer with its own error code before we give up and abort.
 * Settable through AI_LLM_TIMEOUT_MS (tests use a few hundred ms).
 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** GET /extract/version is a lookup in memory; a slow answer is not worth waiting for. */
const VERSION_TIMEOUT_MS = 2_000;

const versionSchema = z.strictObject({
  model: z.string(),
  promptVersion: z.string(),
  pipelineVersion: z.string(),
});

/** Statuses where "try again later" is the right answer, not a verdict on the file. */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 429]);

/**
 * Statuses that say our own settings are wrong (bad token, wrong URL or path), never the file.
 * Retried, and kept as AI_SERVICE_MISCONFIGURED when the attempts run out (see ai-errors.ts).
 */
const MISCONFIGURED: ReadonlySet<number> = new Set([401, 403, 404]);

/**
 * POST /extract over the internal network with the shared bearer token (API.md, ADR 0002).
 * Neither the token, the file, nor any response body ever reaches an error message or a log: the
 * only things taken from the answer are the status class and a validated failure code.
 */
@Injectable()
export class HttpAiExtractor implements AiExtractor {
  private readonly endpoint: URL;
  private readonly versionEndpoint: URL;
  private readonly token: string;
  private readonly llmTimeoutMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.endpoint = new URL('/extract', config.get('AI_SERVICE_URL', { infer: true }));
    this.versionEndpoint = new URL('/extract/version', this.endpoint);
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
    this.llmTimeoutMs = config.get('AI_LLM_TIMEOUT_MS', { infer: true }) ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  async extract(input: AiExtractInput): Promise<AiExtractResponse> {
    const form = new FormData();
    // The file name is a constant: a client-supplied name never travels to the AI service.
    form.set('file', new Blob([new Uint8Array(input.bytes)]), 'document');
    form.set('sourceType', input.sourceType);

    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    // With tracing on, the fetch instrumentation adds the worker span's `traceparent`; setting the
    // job's too would send the header twice (T7.1). With tracing off, hand the job's on as before.
    if (input.traceparent !== undefined && activeTraceparent() === undefined) {
      headers.traceparent = input.traceparent;
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        body: form,
        headers,
        signal: AbortSignal.timeout(
          input.sourceType === 'xml' ? XML_TIMEOUT_MS : this.llmTimeoutMs,
        ),
      });
    } catch {
      throw new TransientExtractionError(); // refused, reset, DNS or timeout
    }

    if (res.ok) return this.parse(res);
    // 501 is the service saying "this path does not exist yet": permanent, unlike a crash (500/502/503).
    if ((res.status >= 500 && res.status !== 501) || RETRYABLE_4XX.has(res.status)) {
      // Keep the AI service's reason (LLM_UNAVAILABLE, LLM_RATE_LIMITED...) for when the attempts
      // run out; a proxy's 502 has no usable code and gets the generic one. Retry-After is the
      // wait the provider asked for after a 429 (T6.2): the worker holds the queue that long.
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const code = await readErrorCode(res);
      const rateLimited = code === RATE_LIMITED_CODE || res.status === 429;
      throw new TransientExtractionError(
        isFailureCode(code) ? code : undefined,
        retryAfterMs,
        rateLimited,
      );
    }
    if (MISCONFIGURED.has(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      throw new TransientExtractionError(AI_SERVICE_MISCONFIGURED);
    }
    // Other 4xx: the service looked at the request and said no. Retrying would get the same answer.
    const code = await readErrorCode(res);
    throw new PermanentExtractionError(isFailureCode(code) ? code : EXTRACTION_FAILED);
  }

  async version(): Promise<ExtractionVersion | null> {
    try {
      const res = await fetch(this.versionEndpoint, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const parsed = versionSchema.safeParse(await res.json());
      // Its parts become a Redis key: only short tokens of known characters (cache-keys.ts).
      return parsed.success && isExtractionVersion(parsed.data) ? parsed.data : null;
    } catch {
      return null; // refused, timeout, not JSON: extract without the cache
    }
  }

  private async parse(res: Response): Promise<AiExtractResponse> {
    // Reading and parsing are separate steps because they fail for different reasons: a body cut
    // off or timed out while it was read (the timeout signal covers it) is the network's, so try
    // again; text that is not JSON is the service's mistake, permanent.
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new TransientExtractionError();
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PermanentExtractionError(EXTRACTION_SCHEMA_INVALID);
    }
    const parsed = aiExtractResponseSchema.safeParse(body);
    // The zod message would echo field values from the invoice, so only the code leaves here.
    if (!parsed.success) throw new PermanentExtractionError(EXTRACTION_SCHEMA_INVALID);
    return parsed.data;
  }
}
