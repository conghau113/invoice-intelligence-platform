'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { InfoBanner } from '@/components/common/info-banner';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DocumentDetail } from '../documents/detail/detail-client';
import { InvoiceForm } from './invoice-form';
import type { ViewerEvidence } from './viewer/types';
import { DocumentViewer } from './viewer/document-viewer';

type Extraction = NonNullable<DocumentDetail['extraction']>;

/**
 * The review screen: the original document on the left, the form on the right (stacked on a
 * narrow screen). Clicking a field makes the viewer jump to where the AI found its value.
 *
 * The form is built once from the extraction it was given. A polling refetch that returns another
 * extraction (the document was reopened and extracted again) does NOT replace it: the reviewer is
 * told and decides, because replacing it would throw away what they typed.
 */
export function ReviewScreen({
  document,
  extraction,
  canEdit,
}: Readonly<{
  document: Pick<DocumentDetail, 'id' | 'sourceType' | 'version'>;
  extraction: Extraction;
  canEdit: boolean;
}>) {
  const t = useTranslations('Review');
  const [shown, setShown] = useState(extraction);
  const [evidence, setEvidence] = useState<ViewerEvidence | null>(null);

  const newerAvailable = extraction.id !== shown.id;
  // The extraction belongs to an older version of the document (it was reopened since).
  const outdated = shown.documentVersion < document.version;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="review-screen">
        {outdated && (
          <InfoBanner>
            {t('outdated', { extraction: shown.documentVersion, current: document.version })}
          </InfoBanner>
        )}
        {newerAvailable && (
          <div
            role="status"
            data-testid="newer-extraction"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
          >
            <span>{t('newerExtraction')}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setShown(extraction);
                setEvidence(null);
              }}
            >
              {t('loadNewer')}
            </Button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:grid lg:grid-cols-2 lg:overflow-hidden">
          <div className="flex h-[70vh] flex-none flex-col lg:h-auto lg:min-h-0">
            <DocumentViewer
              documentId={document.id}
              sourceType={document.sourceType}
              evidence={evidence}
            />
          </div>
          <div className="flex-none lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <InvoiceForm
              key={shown.id}
              extraction={shown}
              canEdit={canEdit}
              onEvidence={setEvidence}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
