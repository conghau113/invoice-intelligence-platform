'use client';

import type { QaCitation } from 'contracts';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { citationHref } from './answer-segments';

const CHIP =
  'mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 align-baseline text-xs font-medium tabular-nums';

/**
 * A source of the answer. It opens the document in a new tab with the cited fields marked, so the
 * answer stays on screen (there is no chat history to come back to). Without its citation (not
 * arrived yet, or a number the list does not have) it is only a muted number, not a link.
 */
export function CitationChip({
  n,
  citation,
}: Readonly<{ n: number; citation: QaCitation | null }>) {
  const t = useTranslations('Qa');
  if (citation === null) {
    return (
      <span className={`${CHIP} bg-muted text-muted-foreground`} data-testid="citation-pending">
        {n}
      </span>
    );
  }
  return (
    <Link
      href={citationHref(citation)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('openSource', { n })}
      title={t('openSource', { n })}
      data-testid="citation-chip"
      data-document-id={citation.documentId}
      className={`${CHIP} bg-primary/10 text-primary hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none`}
    >
      {n}
    </Link>
  );
}
