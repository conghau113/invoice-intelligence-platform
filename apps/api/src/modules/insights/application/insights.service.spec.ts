import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { InsightsRepository } from '../infra/insights.repository';
import { InsightsService } from './insights.service';

const REPO_REPORTS = path.join(__dirname, '../../../../../../eval/reports');

const repository = {
  approvedTotals: () =>
    Promise.resolve({ aiDocuments: 4, xmlDocuments: 1, correctedDocuments: 1, meanCostUsd: 0.002 }),
  correctedFields: () => Promise.resolve([{ field: 'total', documents: 1 }]),
} as unknown as InsightsRepository;

describe('InsightsService', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('puts the online numbers next to the offline report', async () => {
    const body = await new InsightsService(repository, REPO_REPORTS).extraction('t');
    expect(body.online).toMatchObject({
      approvedDocuments: 4,
      uncorrectedDocuments: 3,
      excludedXmlDocuments: 1,
      costUsdPerDocument: 0.002,
    });
    expect(body.online.fields.find((f) => f.field === 'total')).toEqual({
      field: 'total',
      documents: 1,
      rate: 0.25,
    });
    expect(body.offline?.documents).toBe(100);
  });

  it('not configured: offline is null, logged once with the code only', async () => {
    const service = new InsightsService(repository, undefined);
    await service.extraction('t');
    const body = await service.extraction('t');
    expect(body.offline).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Eval report unavailable (NOT_CONFIGURED)');
  });

  it('an unreadable report is read again later: a late mount does not need a restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'eval-late-'));
    try {
      const service = new InsightsService(repository, dir);
      expect((await service.extraction('t')).offline).toBeNull();
      expect(warn).toHaveBeenCalledWith('Eval report unavailable (UNREADABLE)');
      // The reports appear after the first request.
      for (const name of [
        'compare-v1.json',
        'v1-gemini-3.5-flash-lite-invoice_extraction-v1.json',
      ]) {
        const { readFile } = await import('node:fs/promises');
        await writeFile(path.join(dir, name), await readFile(path.join(REPO_REPORTS, name)));
      }
      expect((await service.extraction('t')).offline?.documents).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
