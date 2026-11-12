export const QUERY_EMBEDDER = Symbol('QUERY_EMBEDDER');

/** A question as a unit vector, and the model that made it (chunks of another model are skipped). */
export type QueryEmbedding = { model: string; vector: number[] };

/**
 * The question could not be embedded (AI service down, slow, misconfigured, or a provider error).
 * Carries no cause: the question and the AI service's body must never reach a log or a response.
 */
export class QueryEmbeddingUnavailableError extends Error {
  constructor() {
    super('The question could not be embedded');
    this.name = 'QueryEmbeddingUnavailableError';
  }
}

/** POST /embed of the AI service with `task: "query"` (API.md). Throws QueryEmbeddingUnavailableError. */
export interface QueryEmbedder {
  embed(question: string): Promise<QueryEmbedding>;
}
