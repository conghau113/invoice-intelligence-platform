import type { QaAnswer, QaRoute } from 'contracts';
import { QaModelUnavailableError, type QaModel } from '../application/qa-model.port';

type Step<T> = T | null | ((question: string, sources: string[]) => T | null);

/**
 * Stands in for the AI service's /classify and /answer in tests: no network, no model. Scripted per
 * test; records what it was sent, so a test can check that the router never saw a chunk and that
 * the answer step saw exactly the retrieved chunks.
 */
export class FakeQaModel implements QaModel {
  route: Step<QaRoute> = { intent: 'lookup', filter: null };
  reply: Step<QaAnswer> = { insufficientEvidence: false, answer: 'SAMPLE [1]' };
  fail = false;
  readonly classified: { question: string; today: string }[] = [];
  readonly answered: { question: string; sources: string[] }[] = [];

  classify(question: string, today: string): Promise<QaRoute | null> {
    this.classified.push({ question, today });
    if (this.fail) return Promise.reject(new QaModelUnavailableError());
    const r = this.route;
    return Promise.resolve(typeof r === 'function' ? r(question, []) : r);
  }

  answer(question: string, sources: string[]): Promise<QaAnswer | null> {
    this.answered.push({ question, sources });
    if (this.fail) return Promise.reject(new QaModelUnavailableError());
    const r = this.reply;
    return Promise.resolve(typeof r === 'function' ? r(question, sources) : r);
  }
}
