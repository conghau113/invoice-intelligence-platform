'use client';

import type { Invoice, RuleWarning } from 'contracts';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { InfoBanner } from '@/components/common/info-banner';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { formatDate } from '@/i18n/format';
import type { DocumentDetail } from '../documents/detail/detail-client';
import {
  approveDocument,
  reopenDocument,
  type ApproveFailure,
  type ReopenFailure,
} from './approve-client';
import { InvoiceForm } from './invoice-form';
import type { ViewerEvidence } from './viewer/types';
import { DocumentViewer } from './viewer/document-viewer';

type Extraction = NonNullable<DocumentDetail['extraction']>;

/** What the form is showing: an approved invoice, else what was reopened, else the AI's values. */
interface Shown {
  source: { id: string; documentVersion: number; data: Invoice; warnings: RuleWarning[] };
  approvedAt: string | null;
  /** The version approved before a reopen, when the form started from it. */
  reopenedFromVersion: number | null;
  /** The document version when this was loaded: what an approval must claim to have reviewed. */
  version: number;
}

const toShown = (
  document: Pick<DocumentDetail, 'version' | 'invoice' | 'reopenedFrom'>,
  extraction: Extraction,
): Shown => ({
  source: document.invoice ?? document.reopenedFrom ?? extraction,
  approvedAt: document.invoice?.approvedAt ?? null,
  reopenedFromVersion: document.reopenedFrom?.documentVersion ?? null,
  version: document.version,
});

/**
 * The review screen: the original document on the left, the form on the right (stacked on a
 * narrow screen). Clicking a field makes the viewer jump to where the AI found its value.
 *
 * The form is built once from the data it was given. A refetch that returns something else (someone
 * approved or reopened it) does NOT replace a form being edited: the reviewer is told and decides,
 * because replacing it would throw away what they typed. The version sent with an approval is frozen
 * with that data for the same reason: it says what the person actually reviewed.
 */
export function ReviewScreen({
  document,
  extraction,
  canApprove,
  onChanged,
  citedFields,
}: Readonly<{
  document: Pick<
    DocumentDetail,
    'id' | 'sourceType' | 'version' | 'status' | 'invoice' | 'reopenedFrom'
  >;
  extraction: Extraction;
  /** The person holds `document:approve`. Editing also needs a document waiting for review. */
  canApprove: boolean;
  /** Ask the page to load the document again; settles when it has. */
  onChanged: () => unknown;
  /** Fields a Q&A answer cited, when the page was opened from a citation (T5.5). */
  citedFields?: readonly string[];
}>) {
  const t = useTranslations('Review');
  const tApi = useTranslations('ApiError');
  const locale = useLocale();
  const latest = toShown(document, extraction);
  const [shown, setShown] = useState(latest);
  const [evidence, setEvidence] = useState<ViewerEvidence | null>(null);

  const [submitting, setSubmitting] = useState(false);
  // Set synchronously: a second click before React re-renders must not send a second request.
  const inFlight = useRef(false);
  const [approveError, setApproveError] = useState<ApproveFailure | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<ReopenFailure | null>(null);
  /** This person just approved; holds how many fields they changed. */
  const [justApproved, setJustApproved] = useState<number | null>(null);

  // The source id alone is not enough: a reopened form starts from the invoice already on screen.
  const newerAvailable = latest.source.id !== shown.source.id || latest.version !== shown.version;
  // Nothing typed can be lost: the form is read-only, or what was typed has just been saved.
  if (newerAvailable && (shown.approvedAt !== null || justApproved !== null)) {
    setShown(latest);
    setEvidence(null);
    // "Approved just now" would be about a version that no longer counts as approved.
    if (latest.approvedAt === null) setJustApproved(null);
  }

  const canEdit =
    canApprove &&
    document.status === 'needs_review' &&
    shown.approvedAt === null &&
    justApproved === null;
  const canReopen = canApprove && document.status === 'approved' && shown.approvedAt !== null;

  async function approve(invoice: Invoice) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setApproveError(null);
    setReopenError(null);
    const outcome = await approveDocument(document.id, shown.version, invoice);
    inFlight.current = false;
    setSubmitting(false);
    if (outcome.ok) setJustApproved(outcome.corrections);
    else setApproveError(outcome);
    // Success shows the approved invoice; a conflict shows what changed, without touching the form.
    if (outcome.ok || outcome.kind === 'conflict') void onChanged();
  }

  async function reopen() {
    if (inFlight.current) return;
    inFlight.current = true;
    setReopening(true);
    setReopenError(null);
    try {
      const outcome = await reopenDocument(document.id, shown.version);
      if (!outcome.ok) setReopenError(outcome);
      if (outcome.ok) setApproveError(null);
      // Both a success and a conflict: the page follows what the document is now. The button waits
      // for that, because clicking it again before the new version arrives could only be refused.
      if (outcome.ok || outcome.kind === 'conflict') await onChanged();
    } finally {
      // A stuck ref would block approving as well, since the two share it.
      inFlight.current = false;
      setReopening(false);
    }
  }

  /** Why the form being edited is behind the document. */
  function newerText(): string {
    if (latest.approvedAt !== null) return t('newerApproved');
    if (latest.version > shown.version) return t('newerReopened', { current: latest.version });
    return t('newerExtraction');
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="review-screen">
        {citedFields !== undefined && citedFields.length > 0 && (
          <InfoBanner>{t('citedNote')}</InfoBanner>
        )}
        {shown.reopenedFromVersion !== null && (
          <InfoBanner>{t('reopenedFrom', { version: shown.reopenedFromVersion })}</InfoBanner>
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
        {newerAvailable && justApproved === null && shown.approvedAt === null && (
          <output
            data-testid="newer-extraction"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
          >
            <span>{newerText()}</span>
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
        {(canReopen || reopenError !== null) && (
          <div className="flex flex-wrap items-center gap-3">
            {canReopen && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="reopen"
                disabled={reopening}
                onClick={() => void reopen()}
              >
                {reopening ? t('reopening') : t('reopen')}
              </Button>
            )}
            {/* Out here, not in the form: a conflict replaces the form with what is current. */}
            {reopenError !== null && (
              <p role="alert" data-testid="reopen-error" className="text-sm text-destructive">
                {reopenError.code ? tApi(reopenError.code) : t(`reopenError.${reopenError.kind}`)}
              </p>
            )}
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
              key={shown.source.id}
              extraction={shown.source}
              canEdit={canEdit}
              approved={shown.approvedAt !== null}
              readOnlyText={shown.approvedAt === null ? undefined : t('approvedReadOnly')}
              onEvidence={setEvidence}
              cited={citedFields}
              onValid={(invoice) => void approve(invoice)}
              submitting={submitting}
              submitError={
                approveError === null
                  ? null
                  : approveError.code
                    ? tApi(approveError.code)
                    : t(`approveError.${approveError.kind}`)
              }
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
