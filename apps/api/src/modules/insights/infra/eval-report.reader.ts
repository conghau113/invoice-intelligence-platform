import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OfflineInsightsSchema, type OfflineInsights } from 'contracts';
import { z } from 'zod';

/** The model comparison of T4.4; its `primary.report` names the report of the model in use. */
export const COMPARISON_FILE = 'compare-v1.json';

/** A report name is a bare file stem; anything else (a path, `..`) is refused before it is joined. */
const REPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ratio = z.object({ accuracy: z.number() });
const comparisonSchema = z.object({
  primary: z.object({ report: z.string().regex(REPORT_NAME) }),
});
// Only the aggregate parts are declared; zod drops the rest (`wrong`, `confidentWrong`... hold
// document ids, and nothing here should ever carry more than numbers).
const reportSchema = z.object({
  config: z.object({ dataset: z.string(), model: z.string(), promptVersion: z.string() }),
  fields: z.array(z.string()),
  runDates: z.array(z.string()),
  splits: z.object({
    core: z.object({
      complete: z.literal(true),
      overall: z.object({
        documents: z.number(),
        fields: z.record(z.string(), ratio),
        lines: z.object({ f1: z.number() }),
        documentExact: ratio,
        criticalExact: ratio,
      }),
      usage: z.object({
        costUsdPerDocument: z.number(),
        latency: z.object({ all: z.object({ p50Ms: z.number(), p95Ms: z.number() }) }),
      }),
    }),
  }),
});

/** Why the offline numbers are missing. A code, never a path's content or a parse message. */
export type EvalReportProblem = 'NOT_CONFIGURED' | 'UNREADABLE' | 'INVALID';

export type EvalReportResult =
  { kind: 'ok'; insights: OfflineInsights } | { kind: 'missing'; problem: EvalReportProblem };

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, 'utf8')) as unknown;

/**
 * The offline half of /insights: the `core` split (100 documents) of the primary model's eval
 * report, reduced to aggregate numbers and checked against the contract. The reports are committed
 * files written by `eval/runner`, read from `dir` (EVAL_REPORTS_DIR); a missing or unexpected file
 * is reported as missing, so the page still shows the online numbers.
 */
export async function readEvalReport(dir: string | undefined): Promise<EvalReportResult> {
  if (dir === undefined) return { kind: 'missing', problem: 'NOT_CONFIGURED' };
  let comparison: unknown;
  let report: unknown;
  try {
    comparison = await readJson(path.join(dir, COMPARISON_FILE));
    const primary = comparisonSchema.safeParse(comparison);
    if (!primary.success) return { kind: 'missing', problem: 'INVALID' };
    report = await readJson(path.join(dir, `${primary.data.primary.report}.json`));
  } catch (e) {
    return { kind: 'missing', problem: e instanceof SyntaxError ? 'INVALID' : 'UNREADABLE' };
  }
  const parsed = reportSchema.safeParse(report);
  if (!parsed.success) return { kind: 'missing', problem: 'INVALID' };
  const { config, fields, runDates, splits } = parsed.data;
  const { overall, usage } = splits.core;
  const insights = OfflineInsightsSchema.safeParse({
    model: config.model,
    promptVersion: config.promptVersion,
    dataset: config.dataset,
    runDates: [...new Set(runDates)].sort(),
    documents: overall.documents,
    fields: fields.flatMap((field) => {
      const accuracy = overall.fields[field]?.accuracy;
      return accuracy === undefined ? [] : [{ field, accuracy }];
    }),
    linesF1: overall.lines.f1,
    criticalExact: overall.criticalExact.accuracy,
    documentExact: overall.documentExact.accuracy,
    costUsdPerDocument: usage.costUsdPerDocument,
    latency: usage.latency.all,
  });
  return insights.success
    ? { kind: 'ok', insights: insights.data }
    : { kind: 'missing', problem: 'INVALID' };
}
