'use client';

import type { Invoice, RuleWarning } from 'contracts';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { InfoBanner } from '@/components/common/info-banner';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatDate } from '@/i18n/format';
import type { DocumentDetail } from '../documents/detail/detail-client';
import { approveDocument, type ApproveErrorKind } from './approve-client';
import { InvoiceForm } from './invoice-form';
import type { ViewerEvidence } from './viewer/types';
import { DocumentViewer } from './viewer/document-viewer';

type Extraction = NonNullable<DocumentDetail['extraction']>;

/** What the form is showing: an approved invoice wins over the AI's values. */
interface Shown {
  source: { id: string; documentVersion: number; data: Invoice; warnings: RuleWarning[] };
  approvedAt: string | null;
  /** The document version when this was loaded: what an approval must claim to have reviewed. */
  version: number;
}

const toShown = (
  document: Pick<DocumentDetail, 'version' | 'invoice'>,
  extraction: Extraction,
): Shown => ({
  source: document.invoice ?? extraction,
  approvedAt: document.invoice?.approvedAt ?? null,
  version: document.version,
});

/**
 * The review screen: the original document on the left, the form on the right (stacked on a
 * narrow screen). Clicking a field makes the viewer jump to where the AI found its value.
 *
 * The form is built once from the data it was given. A refetch that returns something else (someone
 * approved it, or it was reopened and extracted again) does NOT replace it: the reviewer is told and
 * decides, because replacing it would throw away what they typed. The version sent with an approval
 * is frozen with that data for the same reason: it says what the person actually reviewed.
 */
export function ReviewScreen({
  document,
  extraction,
  canApprove,
  onChanged,
}: Readonly<{
  document: Pick<DocumentDetail, 'id' | 'sourceType' | 'version' | 'status' | 'invoice'>;
  extraction: Extraction;
  /** The person holds `document:approve`. Editing also needs a document waiting for review. */
  canApprove: boolean;
  /** Ask the page to load the document again. */
  onChanged: () => void;
}>) {
  const t = useTranslations('Review');
  const locale = useLocale();
  const latest = toShown(document, extraction);
  const [shown, setShown] = useState(latest);
  const [evidence, setEvidence] = useState<ViewerEvidence | null>(null);

  const [submitting, setSubmitting] = useState(false);
  // Set synchronously: a second click before React re-renders must not send a second approval.
  const inFlight = useRef(false);
  const [approveError, setApproveError] = useState<ApproveErrorKind | null>(null);
  /** This person just approved; holds how many fields they changed. */
  const [justApproved, setJustApproved] = useState<number | null>(null);

  const newerAvailable = latest.source.id !== shown.source.id;
  // Their own approval comes back from the refetch: nothing of theirs is lost, so follow it.
  if (justApproved !== null && newerAvailable && latest.approvedAt !== null) setShown(latest);

  // The values belong to an older version of the document (it was reopened since).
  const outdated = shown.source.documentVersion < document.version;
  const canEdit =
    canApprove &&
    document.status === 'needs_review' &&
    shown.approvedAt === null &&
    justApproved === null;

  async function approve(invoice: Invoice) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setApproveError(null);
    const outcome = await approveDocument(document.id, shown.version, invoice);
    inFlight.current = false;
    setSubmitting(false);
    if (outcome.ok) setJustApproved(outcome.corrections);
    else setApproveError(outcome.kind);
    // Success shows the approved invoice; a conflict shows what changed, without touching the form.
    if (outcome.ok || outcome.kind === 'conflict') onChanged();
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="review-screen">
        {outdated && (
          <InfoBanner>
            {t('outdated', { extraction: shown.source.documentVersion, current: document.version })}
          </InfoBanner>
        )}
        {justApproved !== null && (
          <output data-testid="approved-now" className="text-sm text-success">
            {t('approvedNow', { count: justApproved })}
          </output>
        )}
        {justApproved === null && shown.approvedAt !== null && (
          <InfoBanner>
            {t('approvedAt', {
              date: formatDate(shown.approvedAt, locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </InfoBanner>
        )}
        {newerAvailable && justApproved === null && (
          <output
            data-testid="newer-extraction"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
          >
            <span>{latest.approvedAt === null ? t('newerExtraction') : t('newerApproved')}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setShown(latest);
                setEvidence(null);
                setApproveError(null);
              }}
            >
              {t('loadNewer')}
            </Button>
          </output>
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
              key={shown.source.id}
              extraction={shown.source}
              canEdit={canEdit}
              readOnlyText={shown.approvedAt === null ? undefined : t('approvedReadOnly')}
              onEvidence={setEvidence}
              onValid={(invoice) => void approve(invoice)}
              submitting={submitting}
              submitError={approveError === null ? null : t(`approveError.${approveError}`)}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
