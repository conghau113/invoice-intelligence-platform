import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from '../../../db/schema';
import {
  QueryEmbeddingUnavailableError,
  type QueryEmbedder,
  type QueryEmbedding,
} from '../application/query-embedder.port';

export const WORD_HASH_MODEL = 'test-word-hash';

// Letters and digits of any script, so "cà" and "phê" are words; one class, no nested repetition.
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Feature hashing over words, like the AI service's FakeEmbedder (not the same hash: the two are
 * never compared). Texts sharing words get close unit vectors, so the vector path behaves like a
 * lexical search: tests can steer it, and a hit@k measured with it says nothing about meaning.
 */
export function wordHashVector(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(WORD) ?? []) {
    const digest = createHash('sha256').update(word).digest();
    const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    v[index]! += digest[4]! % 2 === 0 ? 1 : -1;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1; // no word: a fixed direction, still normalisable
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Stands in for POST /embed in tests: no network. `fail` makes it answer like a dead AI service. */
export class FakeQueryEmbedder implements QueryEmbedder {
  fail = false;
  model = WORD_HASH_MODEL;
  /** Set to return a chosen vector instead of hashing the question. */
  vectorFor?: (question: string) => number[] | undefined;
  readonly questions: string[] = [];

  embed(question: string): Promise<QueryEmbedding> {
    this.questions.push(question);
    if (this.fail) return Promise.reject(new QueryEmbeddingUnavailableError());
    const vector = this.vectorFor?.(question) ?? wordHashVector(question);
    return Promise.resolve({ model: this.model, vector });
  }
}
