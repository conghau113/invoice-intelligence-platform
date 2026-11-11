import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Env } from '../../../config/env.schema';
import { EMBEDDING_DIMENSIONS } from '../../../db/schema';
import {
  QueryEmbeddingUnavailableError,
  type QueryEmbedder,
  type QueryEmbedding,
} from '../application/query-embedder.port';

/**
 * One short text, embedded while a person waits for an answer: a few hundred ms with Gemini. Longer
 * than this, the question fails fast with a code instead of holding the request for the minute an
 * extraction may take (AI_LLM_TIMEOUT_MS).
 */
export const EMBED_QUERY_TIMEOUT_MS = 10_000;

const embedResponseSchema = z.object({
  // z.number() refuses NaN and Infinity, which would make every distance NaN.
  vectors: z.array(z.array(z.number()).length(EMBEDDING_DIMENSIONS)).length(1),
  usage: z.object({ model: z.string().min(1).max(100) }),
});

/**
 * POST /embed over the internal network with the shared bearer token. No retry: the caller is a
 * person (or T5.4's answer), and an error answer is cheaper than a second wait. Neither the token,
 * the question nor any response body reaches an error message.
 */
@Injectable()
export class HttpQueryEmbedder implements QueryEmbedder {
  private readonly endpoint: URL;
  private readonly token: string;
  /** Not configuration; a field so that a test can wait less than 10 s. */
  timeoutMs = EMBED_QUERY_TIMEOUT_MS;

  constructor(config: ConfigService<Env, true>) {
    this.endpoint = new URL('/embed', config.get('AI_SERVICE_URL', { infer: true }));
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
  }

  async embed(question: string): Promise<QueryEmbedding> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        body: JSON.stringify({ texts: [question], task: 'query' }),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new QueryEmbeddingUnavailableError(); // refused, reset, DNS or timeout
    }
    if (!res.ok) {
      // Never read: an error body may echo the question. Release the socket instead.
      await res.body?.cancel().catch(() => undefined);
      throw new QueryEmbeddingUnavailableError();
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      throw new QueryEmbeddingUnavailableError(); // cut off or not JSON
    }
    const parsed = embedResponseSchema.safeParse(body);
    if (!parsed.success) throw new QueryEmbeddingUnavailableError();
    return { model: parsed.data.usage.model, vector: parsed.data.vectors[0]! };
  }
}
