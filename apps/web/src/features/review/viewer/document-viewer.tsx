'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { StatePanel } from '@/components/common/state-panel';
import { ImageViewer } from './image-viewer';
import { TextViewer } from './text-viewer';
import type { ViewerEvidence } from './types';

// pdf.js is large and needs the browser: it is loaded only when a PDF is opened.
const PdfViewer = dynamic(() => import('./pdf-viewer'), {
  ssr: false,
  loading: () => <StatePanel kind="loading" title="…" />,
});

/** The original document, beside the form. One component per kind of file, one common contract: `evidence` says where to look. */
export function DocumentViewer({
  documentId,
  sourceType,
  evidence,
}: Readonly<{
  documentId: string;
  sourceType: 'pdf' | 'image' | 'xml';
  evidence: ViewerEvidence | null;
}>) {
  const t = useTranslations('Review.viewer');
  // Same-origin BFF route (ADR 0006); the id was checked as a uuid by the page.
  const url = `/api/documents/${encodeURIComponent(documentId)}/file`;
  return (
    <section
      aria-label={t('title')}
      data-testid="document-viewer"
      data-source={sourceType}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card"
    >
      {sourceType === 'pdf' && <PdfViewer url={url} evidence={evidence} />}
      {sourceType === 'image' && <ImageViewer url={url} />}
      {sourceType === 'xml' && <TextViewer url={url} evidence={evidence} />}
      <div
        className="flex-none border-t px-3 py-2 text-xs text-muted-foreground"
        data-testid="evidence-caption"
      >
        {evidence ? (
          <>
            <span className="font-medium">
              {sourceType === 'xml' ? t('evidenceXml') : t('evidencePage', { page: evidence.page })}
            </span>
            {': '}
            {/* Document content: rendered as text only, never as markup, never logged. */}
            <q>{evidence.text}</q>
          </>
        ) : (
          t('evidenceHint')
        )}
      </div>
    </section>
  );
}
