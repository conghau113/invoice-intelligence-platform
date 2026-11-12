import type { QaAnswer, QaRoute } from 'contracts';

export const QA_MODEL = Symbol('QA_MODEL');

/**
 * The AI service could not run a Q&A step (down, slow, misconfigured, provider error or quota).
 * Answered as 503 AI_SERVICE_UNAVAILABLE. Carries no cause: the question and the AI service's body
 * must never reach a log or a response.
 */
export class QaModelUnavailableError extends Error {
  constructor() {
    super('The Q&A model could not answer');
    this.name = 'QaModelUnavailableError';
  }
}

/**
 * The model steps of Q&A, served by the AI service (`POST /classify`, `POST /answer`, API.md).
 * `null` means the model answered with something that is not valid for the schema in
 * `packages/contracts/src/qa.ts`: a refusal for the user, not an outage. Throws QaModelUnavailableError.
 */
export interface QaModel {
  /** Sees the question only, never document content. `today` is YYYY-MM-DD in Vietnam. */
  classify(question: string, today: string, signal?: AbortSignal): Promise<QaRoute | null>;
  /** `sources[i]` is cited by the model as `[i + 1]`. */
  answer(question: string, sources: string[], signal?: AbortSignal): Promise<QaAnswer | null>;
}
