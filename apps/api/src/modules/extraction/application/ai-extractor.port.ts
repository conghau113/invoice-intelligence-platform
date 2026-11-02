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
}
