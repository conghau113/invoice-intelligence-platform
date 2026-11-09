import type { ExtractionInsights } from 'contracts';

/** A small, valid GET /insights/extraction body for the tests of this feature. */
export const sampleInsights = (): ExtractionInsights => ({
  online: {
    approvedDocuments: 8,
    uncorrectedDocuments: 6,
    excludedXmlDocuments: 3,
    fields: [
      { field: 'seller.taxCode', documents: 2, rate: 0.25 },
      { field: 'total', documents: 0, rate: 0 },
      { field: 'lines.*.amount', documents: 1, rate: 0.125 },
    ],
    costUsdPerDocument: 0.0045,
  },
  offline: {
    model: 'gemini-3.5-flash-lite',
    promptVersion: 'invoice_extraction/v1',
    dataset: 'v1',
    runDates: ['2026-11-09'],
    documents: 100,
    fields: [
      { field: 'seller.taxCode', accuracy: 0.93 },
      { field: 'vatBreakdown', accuracy: 1 },
    ],
    linesF1: 0.9833,
    criticalExact: 0.93,
    documentExact: 0.85,
    costUsdPerDocument: 0.004504,
    latency: { p50Ms: 4623, p95Ms: 12518 },
  },
});
