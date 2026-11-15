import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnlineInsightsSchema, type ExtractionInsights, type OnlineInsights } from 'contracts';
import { TenantReadCache } from '../../cache/application/tenant-read-cache';
import { correctionRate } from '../domain/correction-rate';
import { readEvalReport, type EvalReportResult } from '../infra/eval-report.reader';
import { InsightsRepository } from '../infra/insights.repository';

/** Directory of the committed eval reports (EVAL_REPORTS_DIR), undefined when not set. */
export const EVAL_REPORTS_DIR = Symbol('EVAL_REPORTS_DIR');

/** The dashboard changes on approve/reopen only, both of which bump the tenant's generation. */
export const INSIGHTS_CACHE_TTL_MS = 60_000;

/**
 * GET /insights/extraction: the online signal (what reviewers corrected in this tenant) next to the
 * offline one (the eval report of the model in use, the same for every tenant).
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);
  // The reports change only with a deploy, so the result is kept for the process. Except an
  // UNREADABLE one: a volume mounted late must not hide the numbers until the next restart.
  private report?: Promise<EvalReportResult>;
  private loggedProblem?: string;

  constructor(
    private readonly repository: InsightsRepository,
    @Inject(EVAL_REPORTS_DIR) private readonly reportsDir: string | undefined,
    private readonly cache: TenantReadCache,
  ) {}

  async extraction(tenantId: string): Promise<ExtractionInsights> {
    // Only the database half is cached per tenant (T6.3); the report is kept for the process below.
    const online = await this.cache.read(
      {
        tenantId,
        name: 'insights-online',
        schema: OnlineInsightsSchema,
        ttlMs: INSIGHTS_CACHE_TTL_MS,
      },
      () => this.online(tenantId),
    );
    return { online, offline: await this.offline() };
  }

  private async online(tenantId: string): Promise<OnlineInsights> {
    // One after the other: both run on the request's single transaction connection.
    const totals = await this.repository.approvedTotals(tenantId);
    const counts = await this.repository.correctedFields(tenantId);
    return {
      approvedDocuments: totals.aiDocuments,
      uncorrectedDocuments: Math.max(0, totals.aiDocuments - totals.correctedDocuments),
      excludedXmlDocuments: totals.xmlDocuments,
      fields: correctionRate(totals.aiDocuments, counts),
      costUsdPerDocument: totals.meanCostUsd,
    };
  }

  private async offline() {
    this.report ??= readEvalReport(this.reportsDir);
    const result = await this.report;
    if (result.kind === 'missing') {
      if (result.problem === 'UNREADABLE') this.report = undefined;
      // Once per problem, and the code only: a path or a parse message has no place in a log line.
      if (this.loggedProblem !== result.problem) {
        this.loggedProblem = result.problem;
        this.logger.warn(`Eval report unavailable (${result.problem})`);
      }
    }
    return result.kind === 'ok' ? result.insights : null;
  }
}
