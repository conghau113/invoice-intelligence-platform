import type { ExtractionVersion } from '../../cache/domain/cache-keys';
import type { AiExtractResponse, SourceType } from '../domain/ai-extract-response';

export const AI_EXTRACTOR = Symbol('AI_EXTRACTOR');

export interface AiExtractInput {
  bytes: Buffer;
  sourceType: SourceType;
  /** Valid W3C traceparent of the job, forwarded so the AI service joins the same trace. */
  traceparent?: string;
}

/**
 * The AI service as the worker sees it (ADR 0002). Contract: resolves with a validated response,
 * throws `PermanentExtractionError(code)` when retrying cannot help, `TransientExtractionError` otherwise.
 */
export interface AiExtractor {
  extract(input: AiExtractInput): Promise<AiExtractResponse>;
  /**
   * What an LLM answer depends on (GET /extract/version, T6.3): the result cache key. Null when the
   * service does not answer it usably; the caller then extracts without the cache. Never throws.
   */
  version(): Promise<ExtractionVersion | null>;
}
