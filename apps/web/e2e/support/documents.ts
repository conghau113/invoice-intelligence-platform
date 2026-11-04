import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** Synthetic invoices and the upload helper shared by the upload and review specs. */

// Playwright runs from apps/web. The synthetic invoice is the one the AI service tests use, so
// there is a single copy. A comment with a random nonce changes the bytes of every run: the API
// dedupes by content hash per tenant, so identical bytes would be "duplicate" on a second run.
const SAMPLE = join(
  process.cwd(),
  '..',
  'ai',
  'tests',
  'fixtures',
  'xml_invoices',
  'invoice-00.xml',
);
export const SELLER = 'Công ty SAMPLE Bán 0';

export function invoiceXml(name: string) {
  const original = readFileSync(SAMPLE, 'utf8');
  return {
    name,
    mimeType: 'application/xml',
    buffer: Buffer.from(original.replace('<HDon>', `<!-- SAMPLE ${randomUUID()} -->\n<HDon>`)),
  };
}

// A committed synthetic PDF. Bytes after %%EOF are ignored by readers; the nonce changes the hash.
const SAMPLE_PDF = join(
  process.cwd(),
  '..',
  'ai',
  'tests',
  'fixtures',
  'pdf_invoices',
  'invoice-00.pdf',
);
// What the AI service's fake LLM provider answers (apps/ai/app/providers/fake.py).
export const FAKE_LLM_SELLER = 'Công ty SAMPLE Bán';

export function invoicePdf(name: string) {
  return {
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.concat([readFileSync(SAMPLE_PDF), Buffer.from(`\n% SAMPLE ${randomUUID()}\n`)]),
  };
}

export async function uploadFile(page: Page, file: ReturnType<typeof invoiceXml>) {
  const answer = page.waitForResponse(
    (r) => r.url().endsWith('/api/documents/upload') && r.request().method() === 'POST',
  );
  await page.getByTestId('file-input').setInputFiles(file);
  const res = await answer;
  return { status: res.status(), id: ((await res.json()) as { id: string }).id };
}
