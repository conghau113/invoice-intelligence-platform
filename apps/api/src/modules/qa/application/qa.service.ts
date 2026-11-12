import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  aggregateFilterProblems,
  todayInVietnam,
  type QaAggregateResult,
  type QaCitation,
  type QaRefusalReason,
} from 'contracts';
import { TenantDbService } from '../../../db/tenant-db.service';
import { RetrievalService } from '../../search/application/retrieval';
import { checkCitations } from '../domain/citations';
import { unsourcedLinks } from '../domain/links';
import { runAggregate } from './aggregate';
import { QA_MODEL, type QaModel } from './qa-model.port';

/** What `POST /qa/ask` streams, decided in full before the first byte is written (API.md). */
export type QaOutcome =
  | { kind: 'answer'; text: string; citations: QaCitation[] }
  | { kind: 'aggregate'; result: QaAggregateResult; citations: QaCitation[] }
  | { kind: 'refusal'; reason: QaRefusalReason };

const refusal = (reason: QaRefusalReason): QaOutcome => ({ kind: 'refusal', reason });

/**
 * Question → cited answer (T5.4, ARCHITECTURE.md §6.2, AI_PIPELINE.md §7).
 *
 * 1. The model routes the question, seeing the question only.
 * 2. Lookup: hybrid retrieval (T5.3) → the model answers from the numbered chunks → every `[n]` must
 *    be a chunk retrieved for this question, and there must be at least one; otherwise refused.
 * 3. Aggregate: the model's structured filter → schema (Zod, in the adapter) and business rules →
 *    parameterized SQL over the `current_*` views. The number goes to the user as data; no model
 *    rewrites it.
 * 4. Out of scope, no evidence, no matching invoice, or an answer that fails a check: a refusal with
 *    a reason, never a guess.
 *
 * No transaction is open while a model or the AI service works: retrieval and the aggregate each
 * open their own short tenant transaction. Logs carry the outcome and counts only.
 */
@Injectable()
export class QaService {
  private readonly log = new Logger(QaService.name);
  /** A field so that a test can fix "today". */
  now: () => Date = () => new Date();

  constructor(
    @Inject(QA_MODEL) private readonly model: QaModel,
    private readonly retrieval: RetrievalService,
    private readonly tenantDb: TenantDbService,
  ) {}

  async ask(tenantId: string, question: string, signal?: AbortSignal): Promise<QaOutcome> {
    const outcome = await this.decide(tenantId, question, signal);
    this.log.log(
      outcome.kind === 'refusal'
        ? `qa refusal reason=${outcome.reason}`
        : `qa ${outcome.kind} citations=${outcome.citations.length}`,
    );
    return outcome;
  }

  private async decide(tenantId: string, question: string, signal?: AbortSignal) {
    const route = await this.model.classify(question, todayInVietnam(this.now()), signal);
    if (route === null) return refusal('ANSWER_REJECTED');
    switch (route.intent) {
      case 'out_of_scope':
        return refusal('OUT_OF_SCOPE');
      case 'aggregate':
        return this.aggregate(tenantId, route.filter);
      case 'lookup':
        return this.lookup(tenantId, question, signal);
    }
  }

  private async aggregate(
    tenantId: string,
    filter: QaAggregateResult['filter'] | null,
  ): Promise<QaOutcome> {
    if (filter === null || aggregateFilterProblems(filter).length > 0) {
      return refusal('ANSWER_REJECTED');
    }
    const result = await this.tenantDb.run(tenantId, (tx) => runAggregate(tx, tenantId, filter));
    if (result.invoiceCount === 0) return refusal('NO_MATCHING_INVOICES');
    return {
      kind: 'aggregate',
      result: {
        filter,
        results: result.results,
        invoiceCount: result.invoiceCount,
        sellers: result.sellers,
        sellerCount: result.sellerCount,
      },
      citations: result.citations,
    };
  }

  private async lookup(
    tenantId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<QaOutcome> {
    const { chunks } = await this.retrieval.retrieve(tenantId, question);
    // No approved invoice is indexed: nothing to answer from, and no model call to pay for.
    if (chunks.length === 0) return refusal('INSUFFICIENT_EVIDENCE');
    const answer = await this.model.answer(
      question,
      chunks.map((c) => c.content),
      signal,
    );
    if (answer === null) return refusal('ANSWER_REJECTED');
    if (answer.insufficientEvidence) return refusal('INSUFFICIENT_EVIDENCE');
    // Checked against the chunks of THIS retrieval, the only ones the model was shown.
    const check = checkCitations(answer.answer, chunks.length);
    if (!check.ok) {
      this.log.warn(`qa answer rejected problem=${check.problem}`);
      return refusal('ANSWER_REJECTED');
    }
    // A link must be written in a source the answer cites: a stored invoice cannot plant one.
    const cited = check.cited.map((n) => chunks[n - 1]!.content);
    if (unsourcedLinks(answer.answer, cited).length > 0) {
      this.log.warn('qa answer rejected problem=UNSOURCED_LINK'); // never the link itself
      return refusal('ANSWER_REJECTED');
    }
    return {
      kind: 'answer',
      text: answer.answer.trim(),
      citations: check.cited.map((n) => {
        const c = chunks[n - 1]!;
        return {
          n,
          documentId: c.documentId,
          documentVersion: c.documentVersion,
          invoiceId: c.invoiceId,
          chunkId: c.chunkId,
          refs: c.refs,
        };
      }),
    };
  }
}
