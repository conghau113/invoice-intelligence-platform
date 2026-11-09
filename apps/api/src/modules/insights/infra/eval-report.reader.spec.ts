import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COMPARISON_FILE, readEvalReport } from './eval-report.reader';

const REPO_REPORTS = path.join(__dirname, '../../../../../../eval/reports');

const report = (overrides: Record<string, unknown> = {}) => ({
  config: { dataset: 'v1', model: 'm-1', promptVersion: 'p/v1' },
  fields: ['invoiceNo', 'total'],
  runDates: ['2026-11-09', '2026-11-08', '2026-11-09'],
  splits: {
    core: {
      complete: true,
      overall: {
        documents: 100,
        fields: { invoiceNo: { accuracy: 0.99 }, total: { accuracy: 1 } },
        lines: { f1: 0.98 },
        documentExact: { accuracy: 0.85 },
        criticalExact: { accuracy: 0.93 },
      },
      usage: { costUsdPerDocument: 0.0045, latency: { all: { p50Ms: 4623, p95Ms: 12518 } } },
      // Per-document details the reader must not carry over.
      wrong: [{ doc: 'invoice-0001', fields: ['total'] }],
    },
  },
  ...overrides,
});

describe('readEvalReport', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'eval-reports-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const write = (name: string, body: unknown) =>
    writeFile(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  const withPrimary = async (body: unknown) => {
    await write(COMPARISON_FILE, { primary: { report: 'r1' } });
    await write('r1.json', body);
  };

  it('reduces the primary report to aggregate numbers, dates deduplicated and sorted', async () => {
    await withPrimary(report());
    expect(await readEvalReport(dir)).toEqual({
      kind: 'ok',
      insights: {
        model: 'm-1',
        promptVersion: 'p/v1',
        dataset: 'v1',
        runDates: ['2026-11-08', '2026-11-09'],
        documents: 100,
        fields: [
          { field: 'invoiceNo', accuracy: 0.99 },
          { field: 'total', accuracy: 1 },
        ],
        linesF1: 0.98,
        criticalExact: 0.93,
        documentExact: 0.85,
        costUsdPerDocument: 0.0045,
        latency: { p50Ms: 4623, p95Ms: 12518 },
      },
    });
  });

  it('reads the real committed report of the primary model', async () => {
    const result = await readEvalReport(REPO_REPORTS);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.insights.documents).toBe(100);
    expect(result.insights.fields.length).toBeGreaterThanOrEqual(12);
    expect(JSON.stringify(result.insights)).not.toContain('invoice-0');
  });

  it('not configured -> NOT_CONFIGURED', async () => {
    expect(await readEvalReport(undefined)).toEqual({ kind: 'missing', problem: 'NOT_CONFIGURED' });
  });

  it('no comparison file -> UNREADABLE', async () => {
    expect(await readEvalReport(dir)).toEqual({ kind: 'missing', problem: 'UNREADABLE' });
  });

  it('a comparison naming a path is refused before anything is read', async () => {
    await write(COMPARISON_FILE, { primary: { report: '../secret' } });
    expect(await readEvalReport(dir)).toEqual({ kind: 'missing', problem: 'INVALID' });
  });

  it.each<[string, unknown]>([
    ['broken JSON', '{"config":'],
    ['an incomplete core split', report({ splits: { core: { complete: false } } })],
    [
      'a rate above 1',
      {
        ...report(),
        fields: ['invoiceNo'],
        splits: {
          core: {
            ...report().splits.core,
            overall: { ...report().splits.core.overall, fields: { invoiceNo: { accuracy: 1.5 } } },
          },
        },
      },
    ],
    ['a run date that is not a date', report({ runDates: ['yesterday'] })],
  ])('%s -> INVALID', async (_, body) => {
    await withPrimary(body);
    expect(await readEvalReport(dir)).toEqual({ kind: 'missing', problem: 'INVALID' });
  });
});
