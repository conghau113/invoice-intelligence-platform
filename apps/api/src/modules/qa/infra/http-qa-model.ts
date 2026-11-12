import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QaAnswerSchema, QaRouteSchema, type QaAnswer, type QaRoute } from 'contracts';
import { z } from 'zod';
import type { Env } from '../../../config/env.schema';
import { QaModelUnavailableError, type QaModel } from '../application/qa-model.port';

/**
 * One model call while a person waits. flash-lite answers a short prompt in a few seconds; past
 * this the request fails with a code instead of hanging. Not retried: a second call costs quota
 * and the person can ask again.
 */
export const QA_MODEL_TIMEOUT_MS = 30_000;
/**
 * The AI service's limit per source (`MAX_SOURCE_CHARS` in apps/ai/app/routers/qa.py). A chunk is
 * cut here rather than refused there: a header chunk has no fixed size (T5.1), and a 422 would make
 * the same question fail forever as if the service were down (code review, T5.4).
 */
export const QA_MAX_SOURCE_CHARS = 20_000;

/** Both routes answer `{output, usage}`; `output` is null when the model's text was invalid. */
const stepResponseSchema = z.object({ output: z.unknown() });

/**
 * POST /classify and /answer over the internal network with the shared bearer token. The AI service
 * already validated `output` with the pydantic models generated from the same contracts; it is
 * validated again here, because what crosses a boundary from a model is untrusted (CLAUDE.md).
 * Neither the token, the question, a source nor any response body reaches an error message.
 */
@Injectable()
export class HttpQaModel implements QaModel {
  private readonly base: string;
  private readonly token: string;
  private readonly demo: boolean;
  /** Not configuration; a field so that a test can wait less than 30 s. */
  timeoutMs = QA_MODEL_TIMEOUT_MS;

  constructor(config: ConfigService<Env, true>) {
    this.base = config.get('AI_SERVICE_URL', { infer: true });
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
    this.demo = config.get('DEMO_READ_ONLY', { infer: true }) === true;
  }

  async classify(question: string, today: string, signal?: AbortSignal): Promise<QaRoute | null> {
    const output = await this.post('/classify', { question, today }, signal);
    return parseOrNull(QaRouteSchema, output);
  }

  async answer(
    question: string,
    sources: string[],
    signal?: AbortSignal,
  ): Promise<QaAnswer | null> {
    const body = {
      question,
      sources: sources.map((content, i) => ({
        n: i + 1,
        content: content.slice(0, QA_MAX_SOURCE_CHARS),
      })),
    };
    return parseOrNull(QaAnswerSchema, await this.post('/answer', body, signal));
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    // The public demo calls no model (ADR 0018). DemoReadOnlyGuard already refuses POST /qa/ask;
    // this second layer holds if a route ever reaches here another way (security review, T5.4).
    if (this.demo) throw new QaModelUnavailableError();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(new URL(path, this.base), {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        // The person closing the page stops the wait, so a dropped question frees its slot at once.
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch {
      throw new QaModelUnavailableError(); // refused, reset, DNS, timeout or cancelled
    }
    if (!res.ok) {
      // Never read: an error body (FastAPI's 422) may echo the question or a source.
      await res.body?.cancel().catch(() => undefined);
      throw new QaModelUnavailableError();
    }
    let parsed: z.ZodSafeParseResult<{ output: unknown }>;
    try {
      parsed = stepResponseSchema.safeParse(JSON.parse(await res.text()));
    } catch {
      throw new QaModelUnavailableError(); // cut off or not JSON
    }
    if (!parsed.success) throw new QaModelUnavailableError();
    return parsed.data.output;
  }
}

function parseOrNull<T>(schema: z.ZodType<T>, output: unknown): T | null {
  if (output === null || output === undefined) return null;
  const parsed = schema.safeParse(output);
  return parsed.success ? parsed.data : null;
}
