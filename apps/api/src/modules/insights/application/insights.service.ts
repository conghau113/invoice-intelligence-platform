import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ExtractionInsights } from 'contracts';
import { correctionRate } from '../domain/correction-rate';
import { readEvalReport, type EvalReportResult } from '../infra/eval-report.reader';
import { InsightsRepository } from '../infra/insights.repository';

/** Directory of the committed eval reports (EVAL_REPORTS_DIR), undefined when not set. */
export const EVAL_REPORTS_DIR = Symbol('EVAL_REPORTS_DIR');

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
  ) {}

  async extraction(tenantId: string): Promise<ExtractionInsights> {
    // One after the other: both run on the request's single transaction connection.
    const totals = await this.repository.approvedTotals(tenantId);
    const counts = await this.repository.correctedFields(tenantId);
    return {
      online: {
        approvedDocuments: totals.aiDocuments,
        uncorrectedDocuments: Math.max(0, totals.aiDocuments - totals.correctedDocuments),
        excludedXmlDocuments: totals.xmlDocuments,
        fields: correctionRate(totals.aiDocuments, counts),
        costUsdPerDocument: totals.meanCostUsd,
      },
      offline: await this.offline(),
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
