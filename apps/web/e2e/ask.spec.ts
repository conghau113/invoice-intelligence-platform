import { expect, test, type Page } from '@playwright/test';
import { invoiceXml, SELLER, uploadFile } from './support/documents';
import { login } from './support/login';

/**
 * T5.5: the Q&A screen against the real stack (web → BFF → API → AI service with
 * `LLM_PROVIDER=fake` → Postgres). It needs the worker too: approving enqueues the RAG index job
 * (T5.2), and only indexed chunks can be retrieved. The fake model answers every lookup with
 * "SAMPLE answer from the fake model provider [1]." (apps/ai/app/providers/fake.py), so this proves
 * the pipeline and the screen, not the quality of an answer.
 */

const FAKE_ANSWER = 'SAMPLE answer from the fake model provider';

/** Uploads a synthetic XML invoice, waits for its extraction and approves it as is. */
async function approveXmlInvoice(page: Page): Promise<string> {
  await page.goto('/vi/upload');
  await page.waitForLoadState('networkidle');
  const { id } = await uploadFile(page, invoiceXml('ask.xml'));
  await page.goto('/vi/documents');
  await expect(
    page.getByTestId(`document-row-${id}`),
    'not needs_review: are the worker and the AI service (LLM_PROVIDER=fake pnpm dev:ai) running?',
  ).toHaveAttribute('data-status', 'needs_review', { timeout: 45_000 });
  await page.goto(`/vi/documents/${id}`, { timeout: 30_000 });
  await page.getByTestId('approve-form').click();
  await expect(page.getByTestId('approved-now')).toBeVisible();
  return id;
}

async function ask(page: Page, question: string) {
  await page.getByTestId('qa-question').fill(question);
  await page.getByTestId('qa-ask').click();
}

/** Server-Sent Events as the API writes them (API.md, `POST /qa/ask`). */
const sse = (events: Array<[string, unknown]>) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');

test.describe('Q&A', () => {
  test('asking streams a cited answer; a citation opens the document with its fields marked', async ({
    page,
  }) => {
    // Two waits on background work (extraction, then indexing) on top of the usual steps.
    test.setTimeout(120_000);
    await login(page, 'accountant');
    await approveXmlInvoice(page);

    await page.goto('/vi/ask');
    await expect(page.getByTestId('qa-screen')).toBeVisible();
    const result = page.getByTestId('qa-result');
    // The index job runs after the approval: until it has, nothing can be retrieved and the answer
    // is "not enough evidence". Ask again until the invoice is searchable.
    await expect(async () => {
      const response = page.waitForResponse((r) => r.url().endsWith('/api/qa/ask'));
      await ask(page, `${SELLER} đã bán những gì?`);
      const res = await response;
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/event-stream');
      // Compressing would buffer the events until the stream ends (Chromium asks for gzip).
      expect(res.headers()['content-encoding']).toBeUndefined();
      await expect(result).toHaveAttribute('data-phase', /^(done|refused)$/);
      await expect(result).toHaveAttribute('data-phase', 'done', { timeout: 1_000 });
    }).toPass({ timeout: 60_000, intervals: [2_000] });

    await expect(page.getByTestId('qa-answer')).toContainText(FAKE_ANSWER);
    const chip = page.getByTestId('citation-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAccessibleName('Mở nguồn 1');
    const documentId = await chip.getAttribute('data-document-id');

    const [doc] = await Promise.all([page.context().waitForEvent('page'), chip.click()]);
    await expect(doc).toHaveURL(new RegExp(`/vi/documents/${documentId}\\?fields=`));
    await expect(doc.getByTestId('review-screen')).toBeVisible({ timeout: 30_000 });
    await expect(doc.getByTestId('info-banner').first()).toContainText('nguồn mà câu trả lời');
    const cited = doc.locator('[data-cited="true"]');
    expect(await cited.count()).toBeGreaterThan(0);
    await expect(cited.first()).toBeInViewport();
    // The answer is still there in the first tab: the source opened beside it.
    await expect(page.getByTestId('qa-answer')).toContainText(FAKE_ANSWER);
  });

  test('stop cancels a question that is still waiting; the request is aborted', async ({
    page,
  }) => {
    await login(page, 'viewer');
    // Hold the request open, as a slow model would: nothing ever comes back.
    await page.route('**/api/qa/ask', () => undefined);
    await page.goto('/vi/ask');
    const failed = page.waitForEvent('requestfailed', (r) => r.url().endsWith('/api/qa/ask'));
    await ask(page, 'Tháng 9 chi bao nhiêu?');
    await expect(page.getByTestId('qa-waiting')).toBeVisible();
    await expect(page.getByTestId('qa-ask')).toBeDisabled();

    await page.getByTestId('qa-stop').click();
    await expect(page.getByTestId('qa-cancelled')).toBeVisible();
    await expect(page.getByTestId('qa-stop')).toHaveCount(0);
    expect((await failed).failure()).not.toBeNull();
  });

  test('an aggregate is written by the web in the locale; a refusal is translated', async ({
    page,
  }) => {
    await login(page, 'viewer', 'en');
    const doc = '3f1c9a52-7d0e-4b7a-9c1d-2a6f0b8e4d11';
    let reply = sse([
      [
        'aggregate',
        {
          filter: {
            metric: 'total',
            sellerName: 'Garcia',
            sellerTaxCode: null,
            issueDateFrom: '2026-09-01',
            issueDateTo: '2026-09-30',
            currency: null,
            itemDescription: null,
          },
          results: [{ currency: 'VND', amount: 12_345_000 }],
          invoiceCount: 2,
          sellers: [{ name: 'Garcia-Riley SAMPLE', taxCode: '0100000001' }],
          sellerCount: 1,
        },
      ],
      [
        'citations',
        {
          citations: [
            {
              n: 1,
              documentId: doc,
              documentVersion: 1,
              invoiceId: '9b5e7f40-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
              chunkId: null,
              refs: [{ document_id: doc, field_path: 'total', page: null }],
            },
          ],
        },
      ],
      ['done', {}],
    ]);
    await page.route('**/api/qa/ask', (route) =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: reply }),
    );
    await page.goto('/en/ask');
    await ask(page, 'How much did we spend with Garcia in September?');
    await expect(page.getByTestId('qa-result')).toHaveAttribute('data-phase', 'done');
    await expect(page.getByTestId('qa-aggregate-value')).toHaveText('₫12,345,000');
    await expect(page.getByTestId('qa-aggregate-filter')).toContainText('Sep 1, 2026');
    await expect(page.getByTestId('citation-chip')).toHaveAttribute(
      'href',
      `/en/documents/${doc}?fields=total`,
    );

    reply = sse([
      ['refusal', { reason: 'OUT_OF_SCOPE' }],
      ['done', {}],
    ]);
    await ask(page, 'What is the weather?');
    await expect(page.getByTestId('qa-refusal')).toContainText('not about your organization');
  });
});
